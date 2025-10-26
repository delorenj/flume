"""Main entry point for task monitoring service."""

import asyncio
import logging
import signal
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import uvicorn
from pydantic_settings import BaseSettings, SettingsConfigDict

from api import create_app
from consumer import TaskEventConsumer, TaskEventPublisher
from models import TaskEvent
from state_manager import TaskStateManager

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("task-monitor.log"),
    ],
)

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    """Application settings from environment variables."""

    model_config = SettingsConfigDict(env_prefix="TASK_MONITOR_")

    # RabbitMQ settings
    rabbitmq_url: str = "amqp://guest:guest@localhost:5672/"
    rabbitmq_exchange: str = "amq.topic"
    rabbitmq_queue: str = "task_monitor_queue"
    rabbitmq_routing_key: str = "task.lifecycle.*"

    # State management
    persistence_enabled: bool = True
    persistence_path: Path = Path("data/task_state.json")
    persistence_interval: int = 60  # seconds
    stale_threshold: int = 300  # 5 minutes
    retention_hours: int = 24

    # API settings
    api_host: str = "0.0.0.0"
    api_port: int = 8000
    api_reload: bool = False

    # Monitoring
    stale_check_interval: int = 60  # seconds
    metrics_enabled: bool = True

    # Logging
    log_level: str = "INFO"


class TaskMonitorService:
    """Main task monitoring service."""

    def __init__(self, settings: Settings) -> None:
        """Initialize service.

        Args:
            settings: Application settings
        """
        self.settings = settings
        self.start_time = datetime.now(timezone.utc)

        # Initialize components
        persistence_path = (
            settings.persistence_path if settings.persistence_enabled else None
        )

        self.state_manager = TaskStateManager(
            persistence_path=persistence_path,
            persistence_interval=settings.persistence_interval,
            stale_threshold=settings.stale_threshold,
            retention_hours=settings.retention_hours,
        )

        self.consumer = TaskEventConsumer(
            rabbitmq_url=settings.rabbitmq_url,
            exchange_name=settings.rabbitmq_exchange,
            queue_name=settings.rabbitmq_queue,
            routing_key_pattern=settings.rabbitmq_routing_key,
        )

        self.publisher = TaskEventPublisher(
            rabbitmq_url=settings.rabbitmq_url,
            exchange_name=settings.rabbitmq_exchange,
        )

        self.app = create_app(self.state_manager, self.start_time)

        # Tasks
        self._stale_check_task: Optional[asyncio.Task] = None
        self._consumer_task: Optional[asyncio.Task] = None
        self._shutdown_event = asyncio.Event()

    async def start(self) -> None:
        """Start the service."""
        logger.info("Starting Task Monitor Service")
        logger.info(f"Settings: {self.settings.model_dump()}")

        try:
            # Initialize state manager
            await self.state_manager.initialize()

            # Connect to RabbitMQ
            await self.consumer.connect()
            await self.publisher.connect()

            # Set event handler
            self.consumer.set_event_handler(self._handle_task_event)

            # Start consumer
            self._consumer_task = asyncio.create_task(self.consumer.start_consuming())

            # Start stale task checker
            self._stale_check_task = asyncio.create_task(self._stale_check_loop())

            logger.info("Task Monitor Service started successfully")

        except Exception as e:
            logger.error(f"Failed to start service: {e}", exc_info=True)
            await self.stop()
            raise

    async def stop(self) -> None:
        """Stop the service."""
        logger.info("Stopping Task Monitor Service")

        # Signal shutdown
        self._shutdown_event.set()

        # Stop consumer
        if self._consumer_task:
            self._consumer_task.cancel()
            try:
                await self._consumer_task
            except asyncio.CancelledError:
                pass

        # Stop stale checker
        if self._stale_check_task:
            self._stale_check_task.cancel()
            try:
                await self._stale_check_task
            except asyncio.CancelledError:
                pass

        # Close connections
        await self.consumer.stop()
        await self.publisher.close()

        # Shutdown state manager
        await self.state_manager.shutdown()

        logger.info("Task Monitor Service stopped")

    async def _handle_task_event(self, task_id: str, event: TaskEvent) -> None:
        """Handle incoming task event.

        Args:
            task_id: Task identifier
            event: Task event
        """
        try:
            # Update state
            await self.state_manager.handle_event(task_id, event)

            # Get updated task
            task = await self.state_manager.get_task(task_id)
            if task:
                # Broadcast to WebSocket clients
                if hasattr(self.app.state, "broadcast_task_update"):
                    try:
                        await self.app.state.broadcast_task_update(task)
                    except Exception as e:
                        logger.error(f"Error broadcasting update: {e}")

        except Exception as e:
            logger.error(
                f"Error handling event for task {task_id}: {e}",
                exc_info=True,
            )

    async def _stale_check_loop(self) -> None:
        """Background loop to check for stale tasks."""
        logger.info(
            f"Starting stale check loop (interval: {self.settings.stale_check_interval}s)"
        )

        try:
            while not self._shutdown_event.is_set():
                await asyncio.sleep(self.settings.stale_check_interval)

                try:
                    stale_tasks = await self.state_manager.get_stale_tasks()

                    if stale_tasks:
                        logger.warning(f"Found {len(stale_tasks)} stale tasks")

                        # Publish alerts for stale tasks
                        for task in stale_tasks:
                            await self.publisher.publish_alert(
                                task_id=task.task_id,
                                alert_type="stale",
                                message=(
                                    f"Task has not sent heartbeat for "
                                    f"{self.settings.stale_threshold}s"
                                ),
                                data={
                                    "status": task.status.value,
                                    "agent_id": task.agent_id,
                                    "last_heartbeat": (
                                        task.last_heartbeat.isoformat()
                                        if task.last_heartbeat
                                        else None
                                    ),
                                },
                            )

                except Exception as e:
                    logger.error(f"Error in stale check loop: {e}", exc_info=True)

        except asyncio.CancelledError:
            logger.info("Stale check loop cancelled")
            raise


def setup_signal_handlers(service: TaskMonitorService) -> None:
    """Setup signal handlers for graceful shutdown.

    Args:
        service: Task monitor service instance
    """

    def signal_handler(sig: int, frame: Optional[object]) -> None:
        """Handle shutdown signals."""
        logger.info(f"Received signal {sig}, shutting down...")
        asyncio.create_task(service.stop())

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)


async def run_service(settings: Settings) -> None:
    """Run the service with uvicorn.

    Args:
        settings: Application settings
    """
    service = TaskMonitorService(settings)

    try:
        # Start service components
        await service.start()

        # Configure uvicorn
        config = uvicorn.Config(
            app=service.app,
            host=settings.api_host,
            port=settings.api_port,
            reload=settings.api_reload,
            log_level=settings.log_level.lower(),
        )

        server = uvicorn.Server(config)

        # Setup signal handlers
        def handle_shutdown() -> None:
            """Handle shutdown signal."""
            asyncio.create_task(service.stop())

        server.install_signal_handlers = lambda: None  # Disable default handlers

        # Run server
        await server.serve()

    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received")
    except Exception as e:
        logger.error(f"Service error: {e}", exc_info=True)
    finally:
        await service.stop()


def main() -> None:
    """Main entry point."""
    # Load settings
    settings = Settings()

    # Set log level
    logging.getLogger().setLevel(settings.log_level)

    # Create data directory if needed
    if settings.persistence_enabled:
        settings.persistence_path.parent.mkdir(parents=True, exist_ok=True)

    # Run service
    try:
        asyncio.run(run_service(settings))
    except KeyboardInterrupt:
        logger.info("Service stopped by user")
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
