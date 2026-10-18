data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "socialflow-${var.env}-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name               = "socialflow-${var.env}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy" "task_s3" {
  name = "s3-access"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = ["arn:aws:s3:::${var.s3_bucket}", "arn:aws:s3:::${var.s3_bucket}/*"]
    }]
  })
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/socialflow-${var.env}"
  retention_in_days = var.env == "prod" ? 30 : 7
}

resource "aws_ecs_cluster" "main" {
  name = "socialflow-${var.env}"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "socialflow-${var.env}-app"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name        = "app"
    image       = var.image_uri
    stopTimeout = 60
    portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV",    value = var.env },
      { name = "PORT",        value = tostring(var.container_port) },
      { name = "S3_BUCKET",   value = var.s3_bucket },
      { name = "AWS_REGION",  value = var.aws_region },
      { name = "REDIS_TLS",   value = "true" }
    ]
    secrets = [
      # DB connection is injected as discrete fields rather than one
      # pre-assembled DATABASE_URL so the password never lands in Terraform
      # state as part of a single combined attribute value — the app builds
      # the connection string itself at runtime (see backend/src/config/config.ts).
      { name = "DB_HOST",      valueFrom = aws_ssm_parameter.db_host.arn },
      { name = "DB_PORT",      valueFrom = aws_ssm_parameter.db_port.arn },
      { name = "DB_NAME",      valueFrom = aws_ssm_parameter.db_name.arn },
      { name = "DB_USER",      valueFrom = aws_ssm_parameter.db_user.arn },
      { name = "DB_PASSWORD",  valueFrom = aws_ssm_parameter.db_password.arn },
      { name = "REDIS_URL",    valueFrom = aws_ssm_parameter.redis_url.arn },
      { name = "JWT_SECRET",   valueFrom = aws_ssm_parameter.jwt_secret.arn }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "app"
      }
    }
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://localhost:${var.container_port}/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
  }])
}

resource "aws_ssm_parameter" "db_host" {
  name  = "/socialflow/${var.env}/DB_HOST"
  type  = "String"
  value = var.db_host
}

resource "aws_ssm_parameter" "db_port" {
  name  = "/socialflow/${var.env}/DB_PORT"
  type  = "String"
  value = tostring(var.db_port)
}

resource "aws_ssm_parameter" "db_name" {
  name  = "/socialflow/${var.env}/DB_NAME"
  type  = "String"
  value = var.db_name
}

resource "aws_ssm_parameter" "db_user" {
  name  = "/socialflow/${var.env}/DB_USER"
  type  = "String"
  value = var.db_username
}

# The password is stored on its own, never concatenated into a connection
# string with the host/user/db name — keeps a single Terraform-tracked
# attribute from ever holding the whole secret.
resource "aws_ssm_parameter" "db_password" {
  name  = "/socialflow/${var.env}/DB_PASSWORD"
  type  = "SecureString"
  value = var.db_password
}

resource "aws_ssm_parameter" "redis_url" {
  name  = "/socialflow/${var.env}/REDIS_URL"
  type  = "SecureString"
  value = var.redis_url
}

resource "aws_ssm_parameter" "jwt_secret" {
  name  = "/socialflow/${var.env}/JWT_SECRET"
  type  = "SecureString"
  value = var.jwt_secret
}

resource "aws_security_group" "alb" {
  name   = "socialflow-${var.env}-alb-sg"
  vpc_id = var.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "socialflow-${var.env}-alb-sg" }
}

resource "aws_lb" "main" {
  name               = "socialflow-${var.env}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids
  tags               = { Env = var.env }
}

resource "aws_lb_target_group" "app" {
  name        = "socialflow-${var.env}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_acm_certificate" "main" {
  domain_name       = var.service_domain
  validation_method = "DNS"

  tags = { Env = var.env }
}

resource "aws_route53_record" "cert_validation" {
  zone_id = var.hosted_zone_id
  name    = tolist(aws_acm_certificate.main.domain_validation_options)[0].resource_record_name
  type    = tolist(aws_acm_certificate.main.domain_validation_options)[0].resource_record_type
  records = [tolist(aws_acm_certificate.main.domain_validation_options)[0].resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [aws_route53_record.cert_validation.fqdn]
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_ecs_service" "app" {
  name            = "socialflow-${var.env}-app"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = var.private_subnet_ids
    security_groups = [var.app_sg_id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = var.container_port
  }

  depends_on = [aws_lb_listener.https]
}
