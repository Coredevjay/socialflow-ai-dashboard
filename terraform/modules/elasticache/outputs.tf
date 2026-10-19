output "primary_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "redis_url" {
  description = "rediss:// connection URL including the AUTH token"
  value       = "rediss://:${random_password.auth_token.result}@${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
  sensitive   = true
}

output "auth_token_secret_arn" {
  value = aws_secretsmanager_secret.auth_token.arn
}
