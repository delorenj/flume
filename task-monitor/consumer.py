"""RabbitMQ consumer for task lifecycle events."""

import asyncio
import json
import logging
from typing import Any, Callable, Optional

import aio_pika
from aio_pika import ExchangeType, Message
from aio_pika.abc import AbstractChannel, AbstractConnection, AbstractIncomingMessage

from models import EventType, TaskEvent, TaskStatus

logger = logging.getLogger(__name__)


class TaskEventConsumer:
    """RabbitMQ consumer for task lifecycle events."""

    def __init__(
        self,
        rabbitmq_url: str,
        exchange_name: str = "amq.topic",
        queue_name: str = "task_monitor_queue",
        routing_key_pattern: str = "task.lifecycle.*",
    ) -> None:
        """Initialize consumer.

        Args:
            rabbitmq_url: RabbitMQ connection URL
            exchange_name: Name of the topic exchange
            queue_name: Name of the queue to create
            routing_key_pattern: Pattern for routing keys to subscribe to
        """
        self.rabbitmq_url = rabbitmq_url
        self.exchange_name = exchange_name
        self.queue_name = queue_name
        self.routing_key_pattern = routing_key_pattern

        self.connection: Optional[AbstractConnection] = None
        self.channel: Optional[AbstractChannel] = None
        self.event_handler: Optional[Callable[[str, TaskEvent], Any]] = None
        self._running = False

    def set_event_handler(
        self, handler: Callable[[str, TaskEvent], Any]
    ) -> None:
        """Set the event handler callback.

        Args:
            handler: Async function that takes (task_id, event) and processes it
        """
        self.event_handler = handler

    async def connect(self) -> None:
        """Establish connection to RabbitMQ."""
        try:
            logger.info(f"Connecting to RabbitMQ at {self.rabbitmq_url}")
            self.connection = await aio_pika.connect_robust(
                self.rabbitmq_url,
                timeout=30,
            )
            self.channel = await self.connection.channel()
            await self.channel.set_qos(prefetch_count=100)

            # Declare topic exchange
            exchange = await self.channel.declare_exchange(
                self.exchange_name,
                ExchangeType.TOPIC,
                durable=True,
            )

            # Declare queue
            queue = await self.channel.declare_queue(
                self.queue_name,
                durable=True,
                arguments={
                    "x-message-ttl": 86400000,  # 24 hours
                    "x-max-length": 100000,  # Max messages
                },
            )

            # Bind queue to exchange with pattern
            await queue.bind(exchange, routing_key=self.routing_key_pattern)

            logger.info(
                f"Queue '{self.queue_name}' bound to exchange '{self.exchange_name}' "
                f"with pattern '{self.routing_key_pattern}'"
            )

        except Exception as e:
            logger.error(f"Failed to connect to RabbitMQ: {e}", exc_info=True)
            raise

    async def start_consuming(self) -> None:
        """Start consuming messages from RabbitMQ."""
        if not self.channel:
            raise RuntimeError("Not connected to RabbitMQ. Call connect() first.")

        if not self.event_handler:
            raise RuntimeError("Event handler not set. Call set_event_handler() first.")

        self._running = True

        try:
            queue = await self.channel.get_queue(self.queue_name)
            logger.info(f"Starting to consume messages from '{self.queue_name}'")

            async with queue.iterator() as queue_iter:
                async for message in queue_iter:
                    if not self._running:
                        break

                    await self._process_message(message)

        except asyncio.CancelledError:
            logger.info("Consumer task cancelled")
            raise
        except Exception as e:
            logger.error(f"Error in consumer loop: {e}", exc_info=True)
            raise

    async def _process_message(self, message: AbstractIncomingMessage) -> None:
        """Process a single RabbitMQ message.

        Args:
            message: Incoming RabbitMQ message
        """
        async with message.process(ignore_processed=True):
            try:
                # Parse message body
                body = json.loads(message.body.decode())

                # Extract task_id from routing key or body
                routing_key = message.routing_key or ""
                task_id = self._extract_task_id(routing_key, body)

                if not task_id:
                    logger.warning(f"No task_id found in message: {routing_key}")
                    await message.ack()
                    return

                # Parse event type from routing key (e.g., "task.lifecycle.started")
                event_type_str = routing_key.split(".")[-1] if routing_key else "unknown"

                # Map event type string to EventType enum
                event_type = self._map_event_type(event_type_str, body)

                # Create TaskEvent
                event = TaskEvent(
                    event_type=event_type,
                    data=body.get("data", {}),
                    agent_id=body.get("agent_id"),
                    message=body.get("message"),
                    timestamp=body.get("timestamp"),
                )

                # Call event handler
                if self.event_handler:
                    await self._call_handler_safely(task_id, event)

                await message.ack()

            except json.JSONDecodeError as e:
                logger.error(f"Invalid JSON in message: {e}")
                await message.reject(requeue=False)
            except Exception as e:
                logger.error(f"Error processing message: {e}", exc_info=True)
                await message.reject(requeue=True)

    def _extract_task_id(self, routing_key: str, body: dict[str, Any]) -> Optional[str]:
        """Extract task_id from routing key or message body.

        Args:
            routing_key: RabbitMQ routing key
            body: Message body

        Returns:
            Task ID or None
        """
        # Try to get from body first
        task_id = body.get("task_id")
        if task_id:
            return str(task_id)

        # Try to extract from routing key (e.g., "task.lifecycle.{task_id}.started")
        parts = routing_key.split(".")
        if len(parts) >= 4:
            return parts[2]

        return None

    def _map_event_type(self, event_type_str: str, body: dict[str, Any]) -> EventType:
        """Map event type string to EventType enum.

        Args:
            event_type_str: Event type from routing key
            body: Message body (may contain explicit event_type)

        Returns:
            EventType enum value
        """
        # Check if explicit event_type in body
        if "event_type" in body:
            event_type_str = body["event_type"]

        # Normalize and map to EventType
        event_type_str = event_type_str.upper()

        try:
            return EventType[event_type_str]
        except KeyError:
            # Default mapping for common variations
            mapping = {
                "ASSIGN": EventType.ASSIGNED,
                "START": EventType.STARTED,
                "PROGRESS": EventType.IN_PROGRESS,
                "COMPLETE": EventType.COMPLETED,
                "FAIL": EventType.FAILED,
                "PAUSE": EventType.PAUSED,
                "RESUME": EventType.RESUMED,
            }
            return mapping.get(event_type_str, EventType.IN_PROGRESS)

    async def _call_handler_safely(self, task_id: str, event: TaskEvent) -> None:
        """Call event handler with error handling.

        Args:
            task_id: Task identifier
            event: Task event
        """
        try:
            if asyncio.iscoroutinefunction(self.event_handler):
                await self.event_handler(task_id, event)
            else:
                # Handle sync handlers
                self.event_handler(task_id, event)
        except Exception as e:
            logger.error(
                f"Error in event handler for task {task_id}: {e}",
                exc_info=True,
            )

    async def stop(self) -> None:
        """Stop consuming and close connections."""
        logger.info("Stopping consumer...")
        self._running = False

        if self.channel and not self.channel.is_closed:
            await self.channel.close()

        if self.connection and not self.connection.is_closed:
            await self.connection.close()

        logger.info("Consumer stopped")

    @property
    def is_connected(self) -> bool:
        """Check if connected to RabbitMQ."""
        return (
            self.connection is not None
            and not self.connection.is_closed
            and self.channel is not None
            and not self.channel.is_closed
        )


class TaskEventPublisher:
    """Publisher for task events and alerts."""

    def __init__(
        self,
        rabbitmq_url: str,
        exchange_name: str = "amq.topic",
    ) -> None:
        """Initialize publisher.

        Args:
            rabbitmq_url: RabbitMQ connection URL
            exchange_name: Name of the topic exchange
        """
        self.rabbitmq_url = rabbitmq_url
        self.exchange_name = exchange_name

        self.connection: Optional[AbstractConnection] = None
        self.channel: Optional[AbstractChannel] = None

    async def connect(self) -> None:
        """Establish connection to RabbitMQ."""
        try:
            logger.info(f"Connecting publisher to RabbitMQ at {self.rabbitmq_url}")
            self.connection = await aio_pika.connect_robust(self.rabbitmq_url)
            self.channel = await self.connection.channel()

            # Declare exchange
            await self.channel.declare_exchange(
                self.exchange_name,
                ExchangeType.TOPIC,
                durable=True,
            )

            logger.info(f"Publisher connected to exchange '{self.exchange_name}'")

        except Exception as e:
            logger.error(f"Failed to connect publisher: {e}", exc_info=True)
            raise

    async def publish_alert(
        self,
        task_id: str,
        alert_type: str,
        message: str,
        data: Optional[dict[str, Any]] = None,
    ) -> None:
        """Publish an alert message.

        Args:
            task_id: Task identifier
            alert_type: Type of alert (e.g., "stale", "failed")
            message: Alert message
            data: Additional data
        """
        if not self.channel or self.channel.is_closed:
            logger.warning("Publisher not connected, skipping alert")
            return

        try:
            exchange = await self.channel.get_exchange(self.exchange_name)

            payload = {
                "task_id": task_id,
                "alert_type": alert_type,
                "message": message,
                "data": data or {},
                "timestamp": TaskEvent().timestamp.isoformat(),
            }

            routing_key = f"task.alert.{alert_type}"

            await exchange.publish(
                Message(
                    body=json.dumps(payload).encode(),
                    content_type="application/json",
                ),
                routing_key=routing_key,
            )

            logger.info(f"Published alert for task {task_id}: {alert_type}")

        except Exception as e:
            logger.error(f"Failed to publish alert: {e}", exc_info=True)

    async def close(self) -> None:
        """Close publisher connections."""
        if self.channel and not self.channel.is_closed:
            await self.channel.close()

        if self.connection and not self.connection.is_closed:
            await self.connection.close()

    @property
    def is_connected(self) -> bool:
        """Check if connected to RabbitMQ."""
        return (
            self.connection is not None
            and not self.connection.is_closed
            and self.channel is not None
            and not self.channel.is_closed
        )
