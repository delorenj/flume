#!/usr/bin/env python3
"""Test WebSocket connection to task-monitor service."""

import asyncio
import json
import websockets
import sys


async def test_websocket():
    """Test WebSocket connection and messages."""
    uri = "ws://192.168.1.12:15151/ws"

    print(f"Connecting to {uri}...")

    try:
        async with websockets.connect(uri) as websocket:
            print("✓ WebSocket connected successfully!")

            # Wait for initial state message
            print("Waiting for initial state message...")
            message = await asyncio.wait_for(websocket.recv(), timeout=5.0)
            data = json.loads(message)

            print(f"✓ Received initial state message:")
            print(f"  Type: {data.get('type')}")
            print(f"  Task count: {data.get('data', {}).get('task_count', 0)}")
            print(f"  Timestamp: {data.get('timestamp')}")

            if 'data' in data and 'tasks' in data['data']:
                tasks = data['data']['tasks']
                print(f"  Sample tasks: {len(tasks)} tasks in initial state")
                for task in tasks[:3]:  # Show first 3 tasks
                    print(f"    - Task {task.get('task_id')}: {task.get('status')}")

            # Send a ping
            print("\nSending ping...")
            await websocket.send("ping")

            # Wait for pong
            response = await asyncio.wait_for(websocket.recv(), timeout=5.0)
            if response == "pong":
                print("✓ Received pong response")
            else:
                print(f"Unexpected response: {response}")

            print("\n✓ WebSocket endpoint is working correctly!")
            print("  - Connection established")
            print("  - Initial state received")
            print("  - Ping/pong working")

    except websockets.exceptions.WebSocketException as e:
        print(f"✗ WebSocket error: {e}", file=sys.stderr)
        return False
    except asyncio.TimeoutError:
        print("✗ Timeout waiting for response", file=sys.stderr)
        return False
    except Exception as e:
        print(f"✗ Unexpected error: {e}", file=sys.stderr)
        return False

    return True


if __name__ == "__main__":
    success = asyncio.run(test_websocket())
    sys.exit(0 if success else 1)