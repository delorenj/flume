.PHONY: help install dev-install test lint format type-check clean run docker-build docker-up docker-down docker-logs example

# Default target
help:
	@echo "Task Monitor Service - Available Commands"
	@echo "=========================================="
	@echo ""
	@echo "Development:"
	@echo "  make install        - Install production dependencies"
	@echo "  make dev-install    - Install development dependencies"
	@echo "  make run            - Run service locally"
	@echo "  make example        - Run example publisher"
	@echo ""
	@echo "Code Quality:"
	@echo "  make format         - Format code with ruff"
	@echo "  make lint           - Lint code with ruff"
	@echo "  make type-check     - Type check with mypy"
	@echo "  make test           - Run tests with pytest"
	@echo "  make test-cov       - Run tests with coverage report"
	@echo "  make check          - Run all quality checks"
	@echo ""
	@echo "Docker:"
	@echo "  make docker-build   - Build Docker image"
	@echo "  make docker-up      - Start services with docker-compose"
	@echo "  make docker-down    - Stop services"
	@echo "  make docker-logs    - View service logs"
	@echo "  make docker-restart - Restart services"
	@echo ""
	@echo "Monitoring:"
	@echo "  make monitoring-up  - Start with monitoring stack"
	@echo "  make monitoring-down - Stop monitoring stack"
	@echo ""
	@echo "Cleanup:"
	@echo "  make clean          - Remove generated files"
	@echo "  make clean-all      - Remove all generated files and data"
	@echo ""

# Installation
install:
	pip install -r requirements.txt

dev-install:
	pip install -r requirements.txt
	pip install pytest pytest-asyncio pytest-cov httpx ruff mypy

install-uv:
	pip install uv
	uv pip install --system -r requirements.txt

# Running
run:
	python main.py

example:
	python example_publisher.py

# Code quality
format:
	ruff format .

lint:
	ruff check .

type-check:
	mypy . --install-types --non-interactive || true

test:
	pytest -v

test-cov:
	pytest --cov=. --cov-report=term-missing --cov-report=html

check: format lint type-check test

# Docker
docker-build:
	docker build -t task-monitor:latest .

docker-up:
	docker-compose up -d

docker-down:
	docker-compose down

docker-logs:
	docker-compose logs -f task-monitor

docker-restart:
	docker-compose restart task-monitor

docker-clean:
	docker-compose down -v

# Monitoring stack
monitoring-up:
	docker-compose --profile monitoring up -d

monitoring-down:
	docker-compose --profile monitoring down

# Cleanup
clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete
	find . -type d -name ".pytest_cache" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name ".mypy_cache" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name ".ruff_cache" -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name "htmlcov" -exec rm -rf {} + 2>/dev/null || true
	rm -f .coverage
	rm -f *.log

clean-all: clean
	rm -rf data/
	rm -rf logs/
	docker-compose down -v

# Development workflow
dev: dev-install
	@echo "Development environment ready!"
	@echo "Run 'make docker-up' to start RabbitMQ"
	@echo "Run 'make run' to start the service"

# Quick start
quickstart:
	@echo "Starting Task Monitor Service..."
	@make docker-up
	@echo "Waiting for services to be ready..."
	@sleep 10
	@echo "Running example publisher..."
	@make example
	@echo ""
	@echo "Service is running! Access points:"
	@echo "  - API:           http://localhost:8000"
	@echo "  - RabbitMQ UI:   http://localhost:15672 (guest/guest)"
	@echo "  - Health Check:  http://localhost:8000/health"
	@echo "  - Metrics:       http://localhost:8000/metrics"
	@echo ""
	@echo "View logs: make docker-logs"
	@echo "Stop services: make docker-down"
