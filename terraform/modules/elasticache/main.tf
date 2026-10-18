terraform {
  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "socialflow-${var.env}-cache-subnet"
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "redis" {
  name   = "socialflow-${var.env}-redis-sg"
  vpc_id = var.vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.app_sg_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "socialflow-${var.env}-redis-sg" }
}

# ElastiCache AUTH tokens may only contain printable ASCII without spaces, '@', '"' or '/'.
resource "random_password" "auth_token" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "auth_token" {
  name = "socialflow-${var.env}-redis-auth"
  tags = { Env = var.env }
}

resource "aws_secretsmanager_secret_version" "auth_token" {
  secret_id     = aws_secretsmanager_secret.auth_token.id
  secret_string = random_password.auth_token.result
}

resource "aws_cloudwatch_log_group" "slow_log" {
  name              = "/socialflow/${var.env}/elasticache/slow-log"
  retention_in_days = var.env == "prod" ? 30 : 7
  tags              = { Env = var.env }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "socialflow-${var.env}"
  description          = "SocialFlow Redis ${var.env}"
  node_type            = var.node_type
  num_cache_clusters   = var.env == "prod" ? 2 : 1
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.auth_token.result
  automatic_failover_enabled = var.env == "prod" ? true : false
  snapshot_retention_limit   = var.env == "prod" ? 7 : 0
  snapshot_window            = "03:00-04:00"
  maintenance_window         = "sun:05:00-sun:06:00"
  tags                       = { Env = var.env }

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.slow_log.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }
}
