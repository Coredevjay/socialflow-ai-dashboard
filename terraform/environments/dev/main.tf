terraform {
  backend "s3" {
    bucket         = "socialflow-terraform-state"
    key            = "env/dev/terraform.tfstate"
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
      Environment = "dev"
      ManagedBy   = "terraform"
    }
  }
}

module "networking" {
  source     = "../../modules/networking"
  env        = "dev"
  cidr_block = "10.0.0.0/16"
}

module "s3" {
  source      = "../../modules/s3"
  env         = "dev"
  bucket_name = "socialflow-dev-assets-${var.account_id}"
}

# App security group shared by ECS, RDS, and ElastiCache. Created here at the
# root rather than inside the ecs module so that rds/elasticache (which need
# to allow ingress from it) don't have to depend on the ecs module, while ecs
# (whose database_url depends on module.rds.endpoint) doesn't have to depend
# on rds's output either. Keeping it at the root breaks what was previously a
# genuine module-level cycle: ecs -> rds (database_url) and rds -> ecs
# (app_sg_id) at the same time.
resource "aws_security_group" "app" {
  name   = "socialflow-dev-app-sg"
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

  tags = { Name = "socialflow-dev-app-sg" }
}

module "ecs" {
  source              = "../../modules/ecs"
  env                 = "dev"
  vpc_id              = module.networking.vpc_id
  public_subnet_ids   = module.networking.public_subnet_ids
  private_subnet_ids  = module.networking.private_subnet_ids
  image_uri           = var.image_uri
  cpu                 = 256
  memory              = 512
  desired_count       = 1
  container_port      = 3001
  app_sg_id           = aws_security_group.app.id
  db_host             = module.rds.endpoint
  db_port             = 5432
  db_name             = var.db_name
  db_username         = var.db_username
  db_master_user_secret_arn = module.rds.master_user_secret_arn
  redis_url           = module.elasticache.redis_url
  jwt_secret          = var.jwt_secret
  jwt_refresh_secret  = var.jwt_refresh_secret
  csrf_secret         = var.csrf_secret
  stripe_secret_key   = var.stripe_secret_key
  twitter_api_key     = var.twitter_api_key
  twitter_api_secret  = var.twitter_api_secret
  s3_bucket           = module.s3.bucket_name
  aws_region          = var.aws_region
  service_domain      = var.service_domain
  hosted_zone_id      = var.hosted_zone_id
}

module "rds" {
  source             = "../../modules/rds"
  env                = "dev"
  vpc_id             = module.networking.vpc_id
  subnet_ids         = module.networking.private_subnet_ids
  db_name            = var.db_name
  db_username        = var.db_username
  instance_class     = "db.t3.micro"
  allocated_storage  = 20
  app_sg_id          = aws_security_group.app.id
}

module "elasticache" {
  source     = "../../modules/elasticache"
  env        = "dev"
  vpc_id     = module.networking.vpc_id
  subnet_ids = module.networking.private_subnet_ids
  node_type  = "cache.t3.micro"
  app_sg_id  = aws_security_group.app.id
}

module "iam" {
  source             = "../../modules/iam"
  env                = "dev"
  aws_region         = var.aws_region
  trusted_principals = var.terraform_trusted_principals
}
