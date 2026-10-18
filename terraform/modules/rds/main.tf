resource "aws_db_subnet_group" "main" {
  name       = "socialflow-${var.env}-db-subnet"
  subnet_ids = var.subnet_ids
  tags       = { Name = "socialflow-${var.env}-db-subnet" }
}

resource "aws_security_group" "rds" {
  name   = "socialflow-${var.env}-rds-sg"
  vpc_id = var.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.app_sg_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "socialflow-${var.env}-rds-sg" }
}

resource "aws_db_parameter_group" "main" {
  name   = "socialflow-${var.env}-params"
  family = "postgres15"

  # shared_buffers is counted in 8 kB pages, so 25% of instance memory is
  # DBInstanceClassMemory/32768 (AWS default formula). It is static, so it needs a reboot.
  parameter {
    name         = "shared_buffers"
    value        = "{DBInstanceClassMemory/32768}"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "work_mem"
    value = "4096"
  }

  # max_connections is static on RDS PostgreSQL as well.
  parameter {
    name         = "max_connections"
    value        = "200"
    apply_method = "pending-reboot"
  }

  tags = { Name = "socialflow-${var.env}-params" }
}

resource "aws_iam_role" "rds_monitoring" {
  name = "socialflow-${var.env}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
    }]
  })

  tags = { Name = "socialflow-${var.env}-rds-monitoring" }
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "main" {
  identifier                      = "socialflow-${var.env}"
  engine                          = "postgres"
  engine_version                  = "15"
  instance_class                  = var.instance_class
  allocated_storage               = var.allocated_storage
  storage_encrypted               = true
  db_name                         = var.db_name
  username                        = var.db_username
  password                        = var.db_password
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.rds.id]
  parameter_group_name            = aws_db_parameter_group.main.name
  skip_final_snapshot             = var.env == "dev"
  deletion_protection             = var.enable_deletion_protection
  multi_az                        = var.multi_az != null ? var.multi_az : var.env == "prod"
  backup_retention_period         = var.backup_retention_days
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  performance_insights_enabled    = true
  monitoring_interval             = 60
  monitoring_role_arn             = aws_iam_role.rds_monitoring.arn
  auto_minor_version_upgrade      = true
  copy_tags_to_snapshot           = true
  tags                            = { Env = var.env }
}
