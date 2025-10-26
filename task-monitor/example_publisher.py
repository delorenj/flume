"""Example task event publisher for testing the task monitor service."""

import asyncio
import json
import random
from datetime import datetime, timezone
from typing import Optional

import aio_pika
from aio_pika import ExchangeType, Message


class TaskEventPublisher:
    """Example publisher for task events."""

    def __init__(self, rabbitmq_url: str = "amqp://guest:guest@localhost:5672/") -> None:
        """Initialize publisher.

        Args:
            rabbitmq_url: RabbitMQ connection URL
        """
        self.rabbitmq_url = rabbitmq_url
        self.connection: Optional[aio_pika.Connection] = None
        self.channel: Optional[aio_pika.Channel] = None
        self.exchange_name = "amq.topic"

    async def connect(self) -> None:
        """Connect to RabbitMQ."""
        self.connection = await aio_pika.connect_robust(self.rabbitmq_url)
        self.channel = await self.connection.channel()

        # Declare exchange
        self.exchange = await self.channel.declare_exchange(
            self.exchange_name,
            ExchangeType.TOPIC,
            durable=True,
        )

        print(f"✓ Connected to RabbitMQ at {self.rabbitmq_url}")

    async def publish_event(
        self,
        task_id: str,
        event_type: str,
        agent_id: Optional[str] = None,
        message: Optional[str] = None,
        data: Optional[dict] = None,
    ) -> None:
        """Publish a task event.

        Args:
            task_id: Task identifier
            event_type: Event type (assigned, started, in_progress, completed, failed)
            agent_id: Optional agent identifier
            message: Optional message
            data: Optional additional data
        """
        if not self.channel or not self.exchange:
            raise RuntimeError("Not connected to RabbitMQ")

        event = {
            "task_id": task_id,
            "event_type": event_type,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "agent_id": agent_id,
            "message": message,
            "data": data or {},
        }

        routing_key = f"task.lifecycle.{event_type}"

        await self.exchange.publish(
            Message(
                body=json.dumps(event).encode(),
                content_type="application/json",
            ),
            routing_key=routing_key,
        )

        print(f"📤 Published {event_type} event for task {task_id}")

    async def close(self) -> None:
        """Close connections."""
        if self.channel:
            await self.channel.close()
        if self.connection:
            await self.connection.close()

        print("✓ Disconnected from RabbitMQ")


async def simulate_task_lifecycle(
    publisher: TaskEventPublisher,
    task_id: str,
    agent_id: str,
    should_fail: bool = False,
) -> None:
    """Simulate a complete task lifecycle.

    Args:
        publisher: Event publisher
        task_id: Task identifier
        agent_id: Agent identifier
        should_fail: Whether task should fail
    """
    print(f"\n🚀 Starting task {task_id} on agent {agent_id}")

    # Assigned
    await publisher.publish_event(
        task_id=task_id,
        event_type="assigned",
        agent_id=agent_id,
        message=f"Task assigned to {agent_id}",
    )
    await asyncio.sleep(0.5)

    # Started
    await publisher.publish_event(
        task_id=task_id,
        event_type="started",
        agent_id=agent_id,
        message="Task execution started",
    )
    await asyncio.sleep(0.5)

    # In progress with heartbeats
    for i in range(3):
        progress = (i + 1) * 33
        await publisher.publish_event(
            task_id=task_id,
            event_type="in_progress",
            agent_id=agent_id,
            message=f"Processing: {progress}% complete",
            data={"progress": progress, "step": i + 1},
        )

        # Send heartbeat
        await asyncio.sleep(0.3)
        await publisher.publish_event(
            task_id=task_id,
            event_type="heartbeat",
            agent_id=agent_id,
        )
        await asyncio.sleep(0.7)

    # Complete or fail
    if should_fail:
        await publisher.publish_event(
            task_id=task_id,
            event_type="failed",
            agent_id=agent_id,
            message="Task failed due to processing error",
            data={"error": "Connection timeout", "retry_count": 3},
        )
        print(f"❌ Task {task_id} failed")
    else:
        await publisher.publish_event(
            task_id=task_id,
            event_type="completed",
            agent_id=agent_id,
            message="Task completed successfully",
            data={"items_processed": 1250, "duration_seconds": 45.2},
        )
        print(f"✅ Task {task_id} completed")


async def simulate_paused_task(
    publisher: TaskEventPublisher,
    task_id: str,
    agent_id: str,
) -> None:
    """Simulate a task that gets paused and resumed.

    Args:
        publisher: Event publisher
        task_id: Task identifier
        agent_id: Agent identifier
    """
    print(f"\n⏸️  Starting pausable task {task_id}")

    # Assigned and started
    await publisher.publish_event(task_id=task_id, event_type="assigned", agent_id=agent_id)
    await asyncio.sleep(0.3)
    await publisher.publish_event(task_id=task_id, event_type="started", agent_id=agent_id)
    await asyncio.sleep(0.5)

    # In progress
    await publisher.publish_event(
        task_id=task_id,
        event_type="in_progress",
        agent_id=agent_id,
        data={"progress": 25},
    )
    await asyncio.sleep(0.5)

    # Pause
    await publisher.publish_event(
        task_id=task_id,
        event_type="paused",
        agent_id=agent_id,
        message="Task paused by user request",
    )
    print(f"⏸️  Task {task_id} paused")
    await asyncio.sleep(2)

    # Resume
    await publisher.publish_event(
        task_id=task_id,
        event_type="resumed",
        agent_id=agent_id,
        message="Task resumed",
    )
    print(f"▶️  Task {task_id} resumed")
    await asyncio.sleep(0.5)

    # Continue and complete
    await publisher.publish_event(
        task_id=task_id,
        event_type="in_progress",
        agent_id=agent_id,
        data={"progress": 100},
    )
    await asyncio.sleep(0.5)

    await publisher.publish_event(
        task_id=task_id,
        event_type="completed",
        agent_id=agent_id,
    )
    print(f"✅ Task {task_id} completed after pause")


async def simulate_stale_task(
    publisher: TaskEventPublisher,
    task_id: str,
    agent_id: str,
) -> None:
    """Simulate a task that goes stale (no heartbeat).

    Args:
        publisher: Event publisher
        task_id: Task identifier
        agent_id: Agent identifier
    """
    print(f"\n💀 Starting stale task {task_id} (will not send heartbeat)")

    # Assigned and started
    await publisher.publish_event(task_id=task_id, event_type="assigned", agent_id=agent_id)
    await asyncio.sleep(0.3)
    await publisher.publish_event(task_id=task_id, event_type="started", agent_id=agent_id)
    await asyncio.sleep(0.3)

    # In progress but no more heartbeats
    await publisher.publish_event(
        task_id=task_id,
        event_type="in_progress",
        agent_id=agent_id,
        message="Starting long-running operation...",
    )

    print(f"💀 Task {task_id} is now running without heartbeats (will become stale)")


async def main() -> None:
    """Main example function."""
    print("=" * 60)
    print("Task Monitor Service - Example Publisher")
    print("=" * 60)

    publisher = TaskEventPublisher()

    try:
        # Connect
        await publisher.connect()

        # Simulate multiple tasks
        agents = ["agent-1", "agent-2", "agent-3"]

        # Run 5 successful tasks
        print("\n" + "=" * 60)
        print("Simulating 5 successful tasks")
        print("=" * 60)

        tasks = []
        for i in range(5):
            task_id = f"task-{random.randint(1000, 9999)}"
            agent_id = random.choice(agents)
            tasks.append(
                simulate_task_lifecycle(
                    publisher,
                    task_id,
                    agent_id,
                    should_fail=False,
                )
            )

        await asyncio.gather(*tasks)

        # Run 2 failed tasks
        print("\n" + "=" * 60)
        print("Simulating 2 failed tasks")
        print("=" * 60)

        tasks = []
        for i in range(2):
            task_id = f"task-{random.randint(1000, 9999)}"
            agent_id = random.choice(agents)
            tasks.append(
                simulate_task_lifecycle(
                    publisher,
                    task_id,
                    agent_id,
                    should_fail=True,
                )
            )

        await asyncio.gather(*tasks)

        # Run 1 paused task
        print("\n" + "=" * 60)
        print("Simulating 1 pausable task")
        print("=" * 60)

        task_id = f"task-{random.randint(1000, 9999)}"
        await simulate_paused_task(publisher, task_id, random.choice(agents))

        # Run 1 stale task
        print("\n" + "=" * 60)
        print("Simulating 1 stale task")
        print("=" * 60)

        task_id = f"task-{random.randint(1000, 9999)}"
        await simulate_stale_task(publisher, task_id, random.choice(agents))

        print("\n" + "=" * 60)
        print("✅ All example tasks published successfully!")
        print("=" * 60)
        print("\nCheck the Task Monitor API:")
        print("  - All tasks:     http://localhost:8000/tasks")
        print("  - Active tasks:  http://localhost:8000/tasks/active")
        print("  - Stale tasks:   http://localhost:8000/tasks/stale")
        print("  - Metrics:       http://localhost:8000/metrics")
        print("  - Health:        http://localhost:8000/health")
        print()

    except Exception as e:
        print(f"\n❌ Error: {e}")
        raise
    finally:
        await publisher.close()


if __name__ == "__main__":
    asyncio.run(main())
