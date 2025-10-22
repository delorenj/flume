# Production Deployment Checklist

Use this checklist to ensure a smooth production deployment of the Task Monitor Service.

## Pre-Deployment

### Environment Setup

- [ ] **RabbitMQ** is deployed and accessible
  - [ ] Version 3.13 or higher
  - [ ] Management plugin enabled
  - [ ] Authentication configured (NOT guest/guest)
  - [ ] TLS/SSL enabled for production
  - [ ] Monitoring enabled

- [ ] **Infrastructure** is ready
  - [ ] Container orchestration (Docker/Kubernetes) configured
  - [ ] Persistent storage for state files
  - [ ] Network policies configured
  - [ ] Load balancer configured (if multiple instances)

- [ ] **Monitoring** infrastructure is set up
  - [ ] Prometheus server running
  - [ ] Grafana dashboards ready
  - [ ] Alert manager configured
  - [ ] Log aggregation system ready (e.g., ELK, Loki)

### Configuration

- [ ] **Environment variables** are set correctly
  ```bash
  # Required
  TASK_MONITOR_RABBITMQ_URL=amqp://user:pass@rabbitmq:5672/

  # Recommended to review
  TASK_MONITOR_PERSISTENCE_ENABLED=true
  TASK_MONITOR_PERSISTENCE_PATH=/data/task_state.json
  TASK_MONITOR_STALE_THRESHOLD=300
  TASK_MONITOR_RETENTION_HOURS=24
  TASK_MONITOR_API_HOST=0.0.0.0
  TASK_MONITOR_API_PORT=8000
  TASK_MONITOR_LOG_LEVEL=INFO
  ```

- [ ] **RabbitMQ** configuration verified
  - [ ] Exchange name matches your publishers
  - [ ] Queue name is unique per environment
  - [ ] Routing key pattern covers all events
  - [ ] Queue durability enabled
  - [ ] Message TTL configured appropriately

- [ ] **Persistence** settings configured
  - [ ] Volume mount for `/data` directory
  - [ ] Backup strategy in place
  - [ ] Persistence interval appropriate for load

- [ ] **Resource limits** set
  - [ ] Memory limits (recommend 512MB-1GB)
  - [ ] CPU limits appropriate for load
  - [ ] Disk space for logs and state files

### Security

- [ ] **Authentication** configured
  - [ ] Add authentication middleware to API
  - [ ] RabbitMQ uses strong credentials
  - [ ] API keys/tokens for client access

- [ ] **Network security** in place
  - [ ] Firewall rules configured
  - [ ] TLS/SSL certificates for API
  - [ ] RabbitMQ TLS enabled
  - [ ] Internal network isolation

- [ ] **Secrets management**
  - [ ] RabbitMQ credentials in secret manager
  - [ ] API keys in secret manager
  - [ ] No hardcoded credentials

- [ ] **File permissions** secured
  - [ ] State files readable only by service user
  - [ ] Log files have appropriate permissions
  - [ ] Service runs as non-root user

### Code Quality

- [ ] **Tests pass**
  ```bash
  pytest --cov=. --cov-report=term-missing
  ```

- [ ] **Linting passes**
  ```bash
  ruff check .
  ```

- [ ] **Type checking passes**
  ```bash
  mypy .
  ```

- [ ] **Code formatted**
  ```bash
  ruff format .
  ```

## Deployment

### Docker Deployment

- [ ] **Build image**
  ```bash
  docker build -t task-monitor:v1.0.0 .
  docker tag task-monitor:v1.0.0 registry.example.com/task-monitor:v1.0.0
  ```

- [ ] **Push to registry**
  ```bash
  docker push registry.example.com/task-monitor:v1.0.0
  ```

- [ ] **Update docker-compose.yml** or Kubernetes manifests
  - [ ] Image tag updated
  - [ ] Environment variables set
  - [ ] Volumes mounted
  - [ ] Health checks configured

- [ ] **Deploy**
  ```bash
  # Docker Compose
  docker-compose up -d

  # Kubernetes
  kubectl apply -f task-monitor-deployment.yaml
  ```

### Kubernetes Deployment

- [ ] **Create namespace**
  ```bash
  kubectl create namespace task-monitor
  ```

- [ ] **Create secrets**
  ```bash
  kubectl create secret generic rabbitmq-creds \
    --from-literal=url='amqp://user:pass@rabbitmq:5672/' \
    -n task-monitor
  ```

- [ ] **Create ConfigMap** (if using)
  ```bash
  kubectl create configmap task-monitor-config \
    --from-env-file=.env.production \
    -n task-monitor
  ```

- [ ] **Deploy application**
  ```bash
  kubectl apply -f deployment.yaml
  kubectl apply -f service.yaml
  kubectl apply -f ingress.yaml
  ```

- [ ] **Configure autoscaling** (if needed)
  ```bash
  kubectl apply -f hpa.yaml
  ```

## Post-Deployment

### Verification

- [ ] **Service is running**
  ```bash
  # Docker
  docker-compose ps
  docker-compose logs task-monitor

  # Kubernetes
  kubectl get pods -n task-monitor
  kubectl logs -f deployment/task-monitor -n task-monitor
  ```

- [ ] **Health check passes**
  ```bash
  curl http://your-service:8000/health
  # Should return: {"status": "healthy", ...}
  ```

- [ ] **RabbitMQ connection successful**
  - [ ] Check logs for "Connected to RabbitMQ"
  - [ ] Verify queue is created in RabbitMQ management UI
  - [ ] Verify queue is bound to exchange

- [ ] **API endpoints accessible**
  ```bash
  curl http://your-service:8000/
  curl http://your-service:8000/tasks
  curl http://your-service:8000/metrics
  ```

- [ ] **Metrics are being collected**
  ```bash
  curl http://your-service:8000/metrics/prometheus
  # Should return Prometheus-formatted metrics
  ```

- [ ] **WebSocket works**
  - Test connection to `ws://your-service:8000/ws`
  - Verify real-time updates are received

### Functional Testing

- [ ] **Publish test event**
  ```bash
  python example_publisher.py
  # Or use your production event publisher
  ```

- [ ] **Verify event processing**
  - [ ] Event appears in RabbitMQ management UI
  - [ ] Task appears in API: `GET /tasks`
  - [ ] Task has correct status and metadata
  - [ ] Event history is stored

- [ ] **Test state transitions**
  - [ ] assigned → started → in_progress → completed
  - [ ] Verify timing metrics are calculated
  - [ ] Verify event history is complete

- [ ] **Test stale detection**
  - [ ] Create task that stops sending heartbeats
  - [ ] Wait for stale threshold
  - [ ] Verify task is marked as stale
  - [ ] Verify alert is published

- [ ] **Test persistence**
  - [ ] Wait for persistence interval
  - [ ] Verify state file is created
  - [ ] Restart service
  - [ ] Verify state is restored

### Monitoring Setup

- [ ] **Prometheus scraping** configured
  - [ ] Add scrape target in prometheus.yml
  - [ ] Verify metrics are being collected
  - [ ] Check Prometheus targets page

- [ ] **Grafana dashboards** created
  - [ ] Task count by status
  - [ ] Success rate over time
  - [ ] Average processing time
  - [ ] Active tasks gauge
  - [ ] Stale tasks count

- [ ] **Alerts configured**
  - [ ] High number of stale tasks
  - [ ] Low success rate
  - [ ] Service down
  - [ ] High memory usage
  - [ ] RabbitMQ connection lost

- [ ] **Logs aggregation** working
  - [ ] Logs are being collected
  - [ ] Structured logging is parsed correctly
  - [ ] Log search works
  - [ ] Log-based alerts configured

### Performance Testing

- [ ] **Load testing** completed
  - [ ] Test with expected event rate
  - [ ] Verify latency is acceptable
  - [ ] Monitor memory usage
  - [ ] Check for memory leaks

- [ ] **Stress testing** completed
  - [ ] Test with 2x-5x expected load
  - [ ] Verify graceful degradation
  - [ ] Check error handling
  - [ ] Verify recovery after spike

- [ ] **Resource usage** is acceptable
  - [ ] Memory usage stable
  - [ ] CPU usage reasonable
  - [ ] Disk I/O not bottleneck
  - [ ] No resource exhaustion

## Ongoing Operations

### Daily

- [ ] Check health endpoint
- [ ] Review error logs
- [ ] Monitor stale task count
- [ ] Check RabbitMQ queue depth

### Weekly

- [ ] Review metrics and trends
- [ ] Check storage usage
- [ ] Review and clear old logs
- [ ] Verify backups are working

### Monthly

- [ ] Review and tune configuration
- [ ] Update dependencies (security patches)
- [ ] Review and update alerts
- [ ] Capacity planning review

## Rollback Plan

- [ ] **Rollback procedure documented**
  ```bash
  # Docker Compose
  docker-compose down
  docker-compose up -d --force-recreate

  # Kubernetes
  kubectl rollout undo deployment/task-monitor -n task-monitor
  ```

- [ ] **Previous version tagged and available**

- [ ] **State backup available** for restore

- [ ] **Rollback tested** in staging

## Disaster Recovery

- [ ] **Backup strategy** defined
  - [ ] State files backed up regularly
  - [ ] Configuration backed up
  - [ ] RabbitMQ queues backed up

- [ ] **Recovery procedure** documented
  - [ ] How to restore from backup
  - [ ] How to recover lost events
  - [ ] How to replay events if needed

- [ ] **Recovery tested** in staging

## Documentation

- [ ] **Runbook** created
  - [ ] Deployment procedure
  - [ ] Common issues and solutions
  - [ ] Emergency contacts
  - [ ] Escalation procedures

- [ ] **Architecture diagram** updated for production

- [ ] **API documentation** published

- [ ] **Team training** completed
  - [ ] How to deploy
  - [ ] How to monitor
  - [ ] How to troubleshoot
  - [ ] How to scale

## Sign-Off

- [ ] **Development team** approves
- [ ] **Operations team** approves
- [ ] **Security team** approves (if required)
- [ ] **Stakeholders** notified

## Post-Deployment Review (After 1 Week)

- [ ] Review metrics and performance
- [ ] Gather feedback from team
- [ ] Identify any issues or concerns
- [ ] Plan improvements for next release

---

## Quick Reference

### Essential Commands

```bash
# Check health
curl http://your-service:8000/health

# View logs
docker-compose logs -f task-monitor
kubectl logs -f deployment/task-monitor

# View metrics
curl http://your-service:8000/metrics

# Restart service
docker-compose restart task-monitor
kubectl rollout restart deployment/task-monitor

# Scale service
docker-compose up -d --scale task-monitor=3
kubectl scale deployment/task-monitor --replicas=3
```

### Important URLs

- API: `http://your-service:8000`
- API Docs: `http://your-service:8000/docs`
- Health: `http://your-service:8000/health`
- Metrics: `http://your-service:8000/metrics/prometheus`
- RabbitMQ: `http://rabbitmq:15672`
- Prometheus: `http://prometheus:9090`
- Grafana: `http://grafana:3000`

### Support Contacts

- Development Team: [team-email@example.com]
- Operations Team: [ops-email@example.com]
- On-Call: [oncall@example.com]

---

**Date Deployed**: _______________

**Deployed By**: _______________

**Version**: _______________

**Environment**: ☐ Development ☐ Staging ☐ Production
