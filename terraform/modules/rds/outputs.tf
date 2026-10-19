output "endpoint" { value = aws_db_instance.main.endpoint }
output "db_name"  { value = aws_db_instance.main.db_name }
output "master_user_secret_arn" { value = aws_db_instance.main.master_user_secret[0].secret_arn }
