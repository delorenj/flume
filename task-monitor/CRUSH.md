# Task Monitor Codebase Guidelines

## Commands
- **Install**: `pip install -e .` or `make dev-install`
- **Build**: `make docker-build`
- **Run**: `make run` or `python main.py`
- **Test**: `make test` or `pytest tests/` (if tests directory exists)
- **Test single**: `pytest path/to/test_file.py::TestClass::test_method` or `pytest -k "test_name"`
- **Lint**: `make lint` or `ruff check .`
- **Format**: `make format` or `ruff format .`
- **Type check**: `make type-check` or `mypy .`
- **All checks**: `make check`

## Code Style
- **Language**: Python 3.12+
- **Imports**: Alphabetically sorted (ruff handles this)
- **Line length**: 88 chars
- **Types**: Enable with mypy strict mode (disallow_untyped_defs, no_implicit_optional, etc.)
- **Naming**: snake_case for variables/functions, PascalCase for classes/types
- **Error handling**: Use try/except with specific exception types, avoid bare except
- **Async**: Use asyncio, async/await syntax preferred
- **Docstrings**: Use Google-style docstrings for functions/classes
- **Testing**: pytest with asyncio support, use pytest-asyncio

## Dependencies
- **Web**: FastAPI, Uvicorn (async web framework)
- **Messaging**: aio-pika (RabbitMQ)
- **Monitoring**: prometheus-client, psutil
- **Data**: Pydantic v2 for models/validation
- **Test**: pytest, pytest-asyncio, pytest-cov, httpx
- **Lint/Format**: ruff (all-in-one formatter/linter)

## Architecture
- **API**: REST/GraphQL endpoints via FastAPI
- **Messaging**: RabbitMQ consumer/producer for tasks
- **State**: In-memory state manager
- **Monitoring**: Prometheus metrics endpoint
- **WebSockets**: Real-time updates via websockets library