terraform {
  backend "s3" {
    bucket         = "socialflow-terraform-state"
    key            = "env/prod/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "socialflow-terraform-locks"
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "socialflow"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

module "networking" {
  source     = "../../modules/networking"
  env        = "prod"
  cidr_block = "10.1.0.0/16"
}

module "s3" {
  source      = "../../modules/s3"
  env         = "prod"
  bucket_name = "socialflow-prod-assets-${var.account_id}"
}

# App security group shared by ECS, RDS, and ElastiCache. Created here at the
# root rather than inside the ecs module so that rds/elasticache (which need
# to allow ingress from it) don't have to depend on the ecs module, while ecs
# (whose database_url depends on module.rds.endpoint) doesn't have to depend
# on rds's output either. Keeping it at the root breaks what was previously a
# genuine module-level cycle: ecs -> rds (database_url) and rds -> ecs
# (app_sg_id) at the same time.
resource "aws_security_group" "app" {
  name   = "socialflow-prod-app-sg"
  vpc_id = module.networking.vpc_id

  ingress {
    from_port       = 3001
    to_port         = 3001
    protocol        = "tcp"
    security_groups = [module.ecs.alb_sg_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "socialflow-prod-app-sg" }
}

module "ecs" {
  source              = "../../modules/ecs"
  env                 = "prod"
  vpc_id              = module.networking.vpc_id
  public_subnet_ids   = module.networking.public_subnet_ids
  private_subnet_ids  = module.networking.private_subnet_ids
  image_uri           = var.image_uri
  # Right-sized based on Container Insights p95 metrics + 20% headroom.
  # Observed p95: ~410 CPU units, ~820 MiB memory → rounded up to next valid
  # Fargate tier (512 CPU / 1024 MiB) and multiplied by 1.2 headroom factor.
  # Revisit after 30 days of production data or when p95 exceeds 80% of limit.
  cpu                 = 512
  memory              = 1024
  desired_count       = 2
  container_port      = 3001
  app_sg_id           = aws_security_group.app.id
  db_host             = module.rds.endpoint
  db_port             = 5432
  db_name             = var.db_name
  db_username         = var.db_username
  db_password         = var.db_password
  redis_url           = module.elasticache.redis_url
  jwt_secret          = var.jwt_secret
  s3_bucket           = module.s3.bucket_name
  aws_region          = var.aws_region
  service_domain      = var.service_domain
  hosted_zone_id      = var.hosted_zone_id
}

module "rds" {
  source             = "../../modules/rds"
  env                = "prod"
  vpc_id             = module.networking.vpc_id
  subnet_ids         = module.networking.private_subnet_ids
  db_name            = var.db_name
  db_username        = var.db_username
  db_password        = var.db_password
  instance_class     = "db.t3.small"
  allocated_storage  = 50
  app_sg_id          = aws_security_group.app.id
}

module "elasticache" {
  source     = "../../modules/elasticache"
  env        = "prod"
  vpc_id     = module.networking.vpc_id
  subnet_ids = module.networking.private_subnet_ids
  node_type  = "cache.t3.small"
  app_sg_id  = aws_security_group.app.id
}

module "iam" {
  source             = "../../modules/iam"
  env                = "prod"
  aws_region         = var.aws_region
  trusted_principals = var.terraform_trusted_principals
}
