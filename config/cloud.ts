import type { CloudConfig } from '@stacksjs/types'
import type { CloudConfig as TsCloudConfig } from '@stacksjs/ts-cloud'
import { servers } from '~/cloud/servers'
import { env } from '@stacksjs/env'

const productionRuntimeEnv = {
  APP_ENV: 'production',
  NODE_ENV: 'production',
  APP_URL: 'https://predicthq.org',
  DEBUG: 'false',
  DB_CONNECTION: 'vitess',
  DB_HOST: '127.0.0.1',
  DB_PORT: '15306',
  DB_DATABASE: 'predicthq',
  DB_USERNAME: 'predicthq',
  DB_VITESS_SHARDED: 'false',
  PORT_API: '3071',
  BROADCAST_HOST: '0.0.0.0',
  BROADCAST_PORT: '3072',
  BROADCAST_SCHEME: 'ws',
  QUEUE_DRIVER: 'database',
  QUEUE_FAILED_DRIVER: 'database',
}

/**
 * Stacks Cloud Configuration
 *
 * This file defines your cloud infrastructure configuration for Stacks.
 * Supports both server mode (Forge-style) and serverless mode (Vapor-style).
 *
 * Environment variables:
 * - CLOUD_ENV: Set the active environment (production, staging, development)
 * - NODE_ENV: Fallback for CLOUD_ENV
 *
 * @see https://github.com/stacksjs/ts-cloud
 */

// ts-cloud configuration for deployment
export const tsCloud: TsCloudConfig = {
  /**
   * Project configuration
   */
  project: {
    name: 'predicthq',
    slug: 'predicthq',
    region: 'us-east-1', // Default AWS region
  },

  // Deploy compute to Hetzner Cloud (apiToken falls back to HCLOUD_TOKEN env).
  cloud: {
    provider: 'hetzner',

    // Run as a tenant on the box the `stacks` project owns
    // (`stacks-production-app`) instead of provisioning our own. Attaching
    // skips provisioning entirely, which is the point: the owner holds :80
    // and :443 and its rpx gateway routes every domain on the box. A tenant
    // that provisioned would rewrite that gateway with only its own sites
    // and take stacksjs.com down with it.
    //
    // Our routes land in `/etc/rpx/sites.d/predicthq.json`, a drop-in the
    // owner merges. Eleven other projects share the box the same way.
    attachTo: 'stacks',
  },

  /**
   * Deployment Mode
   *
   * - 'server': Traditional EC2-based deployment (Forge-style)
   * - 'serverless': Container + static site deployment (Vapor-style)
   */
  mode: 'server',

  /**
   * Environment configurations
   * Each environment can have its own settings
   *
   * Note: Deployment mode is automatically determined by your infrastructure configuration.
   * Simply define the resources you need below (functions, servers, storage, etc.) and
   * ts-cloud will deploy them accordingly. You can mix and match any resources.
   */
  environments: {
    production: {
      type: 'production',
      region: 'us-east-1',
      variables: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
      },

      /**
       * Serverless Application (Vapor-style) — optional
       *
       * Deploy one codebase as three AWS Lambda functions sharing one artifact:
       * HTTP (API Gateway v2), a queue worker (SQS, one job per invocation), and
       * a CLI function (EventBridge scheduler + on-demand commands / migrations).
       *
       * Defining `app` opts this environment into the serverless deploy pipeline
       * (`buddy deploy --serverless`). Leave it commented to keep the default
       * server/container deployment. Every option is shown below.
       *
       * @see https://ts-cloud.stacksjs.com/features/serverless
       */
      // app: {
      //   // Runtime + application kind. Common Node versions use the AWS managed
      //   // runtime; Bun and newer Node (e.g. 24) run on a ts-cloud-built
      //   // provided.al2023 custom layer (built once via `buddy cloud` / the
      //   // `serverless:build-{node,bun,php}-layer` ts-cloud CLI commands).
      //   kind: 'node', // 'node' | 'bun' | 'php'
      //   runtimeVersion: '22', // node: 18/20/22 (managed) or 24+ (custom layer); bun: a release
      //   // runtime: 'provided.al2023', // override (usually derived from kind + runtimeVersion)
      //   entry: 'server.ts', // entry exporting { fetch, queue, cli } (node/bun)
      //
      //   // HTTP function.
      //   memory: 1024, // MB
      //   timeout: 28, // seconds (API Gateway v2 caps at 29)
      //   concurrency: undefined, // reserved concurrency, optional
      //   gatewayVersion: 2, // 2 = HTTP API (default), 1 = REST API
      //   warm: 2, // keep N containers warm via scheduled pings
      //
      //   // CLI function (scheduler + commands/migrations).
      //   cliMemory: 1024,
      //   cliTimeout: 900,
      //
      //   // Queue worker.
      //   queues: true, // true = single default queue; or ['emails', { invoices: 10 }]; false = disabled
      //   queueConcurrency: 1000,
      //   queueTimeout: 120,
      //   queueMemory: 1024,
      //   queueTries: 3, // max receives before DLQ
      //
      //   // Scheduler: 'on' | 'off' | 'sub-minute'.
      //   scheduler: 'on',
      //
      //   // Build hooks (local, before packaging) + deploy hooks (remote, via CLI fn).
      //   build: ['bun install', 'bun run build'],
      //   deploy: ['migrate'],
      //
      //   // Persistent mode (Laravel Octane / long-lived server). Lower latency.
      //   octane: false,
      //
      //   // Packaging: 'zip' (default) or 'image' (ECR container, for >250MB apps).
      //   packaging: 'zip',
      //
      //   // Static assets → S3 + CloudFront, exposed as ASSET_URL.
      //   assets: 'public',
      //
      //   // Custom domain + ACM certificate.
      //   domain: 'app.stacksjs.com',
      //   // certificateArn: 'arn:aws:acm:us-east-1:...:certificate/...',
      //
      //   // Managed data (require vpc.subnets — private subnets):
      //   // vpc: { subnets: ['subnet-aaa', 'subnet-bbb'], securityGroups: [] },
      //   // database: { connection: 'aurora-serverless' },
      //   // rdsProxy: true,
      //   cache: { driver: 'dynamodb' }, // 'dynamodb' (zero-NAT default) | 'elasticache'
      //   // storage: { bucket: 'stacks-production-app' },
      //
      //   // Managed WAF in front of the HTTP API.
      //   // firewall: { enabled: true, rateLimit: 2000, rules: ['common', 'sqlInjection'] },
      //
      //   // Env vars + secrets (secrets resolved from Secrets Manager / SSM at deploy).
      //   env: { APP_ENV: 'production' },
      //   // secrets: ['APP_KEY', 'DB_PASSWORD'],
      //
      //   // Ephemeral /tmp size in MB (512–10240).
      //   tmpStorage: 512,
      //
      //   // PHP-only (kind: 'php'):
      //   // phpVersion: '8.3',
      //   // architecture: 'x86_64', // or 'arm64'
      //   // layers: ['arn:aws:lambda:us-east-1:...:layer:tscloud-php-83-x86_64:1'],
      // },
    },
    staging: {
      type: 'staging',
      region: 'us-east-1',
      variables: {
        NODE_ENV: 'staging',
        LOG_LEVEL: 'debug',
      },
    },
    development: {
      type: 'development',
      region: 'us-east-1',
      variables: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
      },
    },
  },

  /**
   * Infrastructure configuration
   * Define your cloud resources here
   */
  infrastructure: {
    /**
     * Compute Configuration
     *
     * For mode: 'server'
     * Defines the EC2 instances running your Stacks/Bun application.
     * When instances > 1, load balancer is automatically enabled.
     *
     * For mode: 'serverless'
     * These settings are not used. See 'containers' configuration instead.
     *
     * @example Single instance (development/staging)
     * compute: { instances: 1, size: 'micro' }
     *
     * @example Multiple instances with auto-scaling (production)
     * compute: {
     *   instances: 3,
     *   size: 'small',
     *   autoScaling: { min: 2, max: 10, scaleUpThreshold: 70 },
     * }
     *
     * @example Mixed instance fleet for cost optimization
     * compute: {
     *   instances: 3,
     *   fleet: [
     *     { size: 'small', weight: 1 },
     *     { size: 'medium', weight: 2 },
     *     { size: 'small', weight: 1, spot: true },
     *   ],
     *   spotConfig: {
     *     baseCapacity: 1,           // Always keep 1 on-demand
     *     onDemandPercentage: 50,    // 50% on-demand, 50% spot
     *     strategy: 'capacity-optimized',
     *   },
     * }
     */
    compute: {
      instances: 1,
      size: 'small', // Provider-agnostic: 'nano', 'micro', 'small', 'medium', 'large', 'xlarge', '2xlarge' (small = 2GB RAM, needed for bun install)
      disk: {
        size: 20,
        type: 'ssd', // Provider-agnostic: 'standard', 'ssd', 'premium'
        encrypted: true,
      },
      webServer: 'rpx',
      proxy: {
        engine: 'rpx',
        onDemandTls: true,
        onDemandTlsEmail: 'hello@stacksjs.com',
      },
      // Uncomment for auto-scaling:
      // autoScaling: {
      //   min: 1,
      //   max: 5,
      //   scaleUpThreshold: 70,
      //   scaleDownThreshold: 30,
      // },
      // Uncomment for mixed instance fleet:
      // fleet: [
      //   { size: 'micro', weight: 1 },
      //   { size: 'small', weight: 2 },
      //   { size: 'micro', weight: 1, spot: true },
      // ],
      // spotConfig: {
      //   baseCapacity: 1,
      //   onDemandPercentage: 50,
      //   strategy: 'capacity-optimized',
      // },
    },

    /**
     * Server Definitions
     * EC2 instances for server mode deployment
     */
    servers: {
      app: servers.app,
      // app2: servers.app2,
      // web: servers.web,
      // cache: servers.cache,
    } as NonNullable<TsCloudConfig['infrastructure']>['servers'],

    /**
     * Jump Box / Bastion Host
     *
     * Provides SSH access to your private cloud resources.
     * Set to `true` for a default t3.micro jump box, or configure options.
     *
     * Connect via: buddy cloud:ssh
     * Or via SSM: aws ssm start-session --target <instance-id>
     */
    // jumpBox: true,
    // jumpBox: {
    //   enabled: true,
    //   size: 'micro',
    //   keyName: 'stacks-production',
    //   allowedCidrs: ['0.0.0.0/0'],
    //   databaseTools: true,
    //   mountEfs: true,
    // },

    /**
     * Container Configuration (for serverless mode only)
     *
     * Defines ECS Fargate containers running your Bun API.
     * Only used when mode: 'serverless'.
     *
     * @example Basic API container
     * containers: {
     *   api: {
     *     cpu: 256,    // 0.25 vCPU
     *     memory: 512, // 512 MB
     *     port: 3000,
     *     healthCheck: '/health',
     *   }
     * }
     *
     * @example Production API with auto-scaling
     * containers: {
     *   api: {
     *     cpu: 512,
     *     memory: 1024,
     *     port: 3000,
     *     desiredCount: 2,
     *     autoScaling: {
     *       min: 2,
     *       max: 10,
     *       targetCpuUtilization: 70,
     *     },
     *   }
     * }
     */
    containers: {
      api: {
        cpu: 512, // 256, 512, 1024, 2048, 4096
        memory: 1024, // Must be compatible with CPU (512 MB - 16 GB)
        port: 3000,
        healthCheck: '/health',
        desiredCount: 2,
        autoScaling: {
          min: 1,
          max: 10,
          targetCpuUtilization: 70,
          targetMemoryUtilization: 80,
        },
      },
    },

    /**
     * Load Balancer Configuration
     *
     * Controls whether to use an Application Load Balancer (ALB) for traffic distribution.
     * Automatically enabled when compute.instances > 1.
     *
     * Benefits of ALB:
     * - SSL termination with ACM certificates (free)
     * - Health checks and automatic failover
     * - HTTP to HTTPS redirect
     * - Multiple target support
     *
     * When to disable:
     * - Cost optimization (ALB costs ~$16/month minimum)
     * - Simple single-instance deployments
     * - Using Let's Encrypt for SSL instead of ACM
     */
    loadBalancer: {
      enabled: true,
      type: 'application',
      healthCheck: {
        path: '/health',
        interval: 30,
        healthyThreshold: 2,
        unhealthyThreshold: 5,
      },
    },

    /**
     * SSL/TLS Configuration
     *
     * Supports two providers:
     * - 'acm': AWS Certificate Manager (free, requires ALB or CloudFront)
     * - 'letsencrypt': Free certificates (works without ALB, runs on EC2)
     *
     * When loadBalancer.enabled = true:
     *   - Uses ACM by default (recommended)
     *   - Certificates are automatically requested and validated via DNS
     *   - HTTP to HTTPS redirect handled by ALB
     *
     * When loadBalancer.enabled = false:
     *   - Uses Let's Encrypt by default
     *   - Certificates are obtained and renewed automatically on EC2
     *   - Requires port 80 for HTTP-01 challenge or DNS for DNS-01
     */
    ssl: {
      enabled: true,
      provider: 'acm', // 'acm' | 'letsencrypt'
      domains: env.SSL_DOMAINS?.split(',') || ['stacksjs.com', 'www.stacksjs.com'],
      redirectHttp: true,
      // Let's Encrypt configuration (used when provider: 'letsencrypt' or loadBalancer.enabled: false)
      letsEncrypt: {
        email: env.LETSENCRYPT_EMAIL || 'admin@stacksjs.com',
        staging: false, // Set to true for testing
        autoRenew: true,
      },
    },

    /**
     * DNS Configuration
     */
    dns: {
      domain: env.APP_DOMAIN || 'stacksjs.com',
      hostedZoneId: env.AWS_HOSTED_ZONE_ID || 'Z01455702Q7952O6RCY37', // Route53 hosted zone ID
    },

    /**
     * Storage Configuration
     * S3 buckets for frontend, assets, uploads, etc.
     *
     * Mirrors the old CDK StorageStack defaults:
     * - public: website-hosting bucket for frontend (index.html)
     * - private: locked-down bucket for uploads, secrets, etc.
     * - docs: website-hosting bucket for documentation (conditional)
     * - logs: access-log bucket (retained on delete for audit)
     *
     * NOTE: The `public`, `docs`, and `blog` website-hosting buckets below are
     * being SUPERSEDED by the server-static `sites` entries (see `sites` at the
     * bottom of this file), which build each static site locally and ship it to
     * `/var/www/<site>` on the Hetzner box (served by the reverse proxy's
     * `file_server`). They are intentionally LEFT IN PLACE as the rollback path
     * and to keep their existing CloudFront distributions alive during the
     * migration. Once the Hetzner server-static sites are verified in
     * production, these three website-hosting buckets (and their CloudFront)
     * can be decommissioned.
     */
    storage: {
      'public': {
        public: true,
        encryption: true,
        versioning: true,
        website: {
          indexDocument: 'index.html',
          errorDocument: 'index.html',
        },
      },
      'private': {
        encryption: true,
        versioning: true,
      },
      'docs': {
        public: true,
        encryption: true,
        versioning: true,
        path: '/docs',
        pathRewriteStyle: 'flat',
        website: {
          indexDocument: 'index.html',
          errorDocument: '404.html',
        },
      },
      'blog': {
        public: true,
        encryption: true,
        versioning: true,
        path: '/blog',
        website: {
          indexDocument: 'index.html',
          errorDocument: '404.html',
        },
      },
      'logs': {
        encryption: true,
        versioning: false,
      },
      'backups': {
        encryption: true,
        versioning: true,
      },
      'email': {
        public: false,
        encryption: true,
        versioning: false,
      },
    },

    /**
     * Functions Configuration (optional)
     * Lambda functions for specific serverless workloads
     *
     * Note: Stacks uses Bun-based routing (./routes) for APIs, not Lambda functions.
     * Only add functions here for specific use cases like:
     * - Background job processing
     * - Event-driven tasks
     * - Image processing
     * - Scheduled tasks
     */
    functions: {
      // Example background worker (optional)
      // 'background-worker': {
      //   handler: 'worker.handler',
      //   runtime: 'nodejs20.x',
      //   timeout: 300,
      //   memorySize: 1024,
      // },
    },

    /**
     * Queue Configuration (SQS)
     * Background job processing, event-driven tasks, and scheduled work.
     *
     * Jobs defined in app/Jobs/*.ts are auto-discovered at deploy time
     * and scheduled via EventBridge rules targeting these queues.
     */
    queues: {
      jobs: {
        visibilityTimeout: 120,
        deadLetterQueue: true,
        maxReceiveCount: 3,
      },
      // Uncomment for ordered processing:
      // orders: {
      //   fifo: true,
      //   contentBasedDeduplication: true,
      // },
    },

    /**
     * Database Configuration (optional)
     */
    databases: {
      // Uncomment to add a database
      // 'main': {
      //   engine: 'postgres',
      //   instanceClass: 'db.t3.micro',
      //   storage: 20,
      //   username: 'admin',
      //   password: 'changeme123', // Use AWS Secrets Manager in production
      // },
    },

    /**
     * CDN Configuration
     * CloudFront distribution for global content delivery
     */
    cdn: {
      // Uncomment to enable CloudFront CDN
      // 'frontend': {
      //   origin: 'stacks-production-frontend.s3.us-east-1.amazonaws.com',
      //   customDomain: 'cdn.stacks-js.org',
      // },
    },

    /**
     * Redirects Configuration
     * Domain-level and path-level URL redirects.
     *
     * Domain redirects create S3 redirect buckets.
     * Path redirects create CloudFront Functions.
     */
    // redirects: {
    //   // Redirect these domains to your primary domain
    //   // domains: ['www.stacksjs.com', 'stacks.dev'],
    //   // target: 'stacksjs.com',
    //
    //   // Path-level redirects (source -> target)
    //   // paths: {
    //   //   '/old-page': '/new-page',
    //   //   '/blog/old-post': '/blog/new-post',
    //   // },
    // },

    /**
     * Cache Configuration (ElastiCache)
     * Redis or Memcached for in-memory caching
     */
    // Cache temporarily disabled for initial deployment - enable after stack is stable
    // cache: {
    //   type: 'redis',
    //   nodeType: 'cache.t3.micro',
    //   redis: {
    //     engineVersion: '7.1',
    //     numCacheNodes: 2,
    //     automaticFailoverEnabled: true,
    //     snapshotRetentionLimit: 7,
    //   },
    // },

    /**
     * Email Configuration (SES)
     * Amazon SES for transactional email sending
     *
     * Domain is auto-detected from dns.domain if not specified.
     * DNS records (SPF, DKIM, DMARC) are auto-created when hostedZoneId is available.
     *
     * Note: 'email' is not a valid property on InfrastructureConfig.
     * Uncomment and move to a supported config section when the type supports it.
     */
    // email: {
    //   domain: 'stacksjs.com',
    //   configurationSet: true,
    //   enableDkim: true,
    //   server: {
    //     enabled: true,
    //   },
    // },

    /**
     * Search Configuration (OpenSearch)
     * Full-text search engine powered by OpenSearch
     */
    // search: {
    //   instanceType: 't3.small.search',
    //   instanceCount: 1,
    //   volumeSize: 10,
    //   volumeType: 'gp3',
    //   encryption: {
    //     atRest: true,
    //     nodeToNode: true,
    //   },
    //   autoTune: true,
    // },

    /**
     * File System Configuration (EFS)
     * Elastic File System for shared storage across instances
     */
    // fileSystem: {
    //   shared: {
    //     encrypted: true,
    //     performanceMode: 'generalPurpose',
    //     throughputMode: 'bursting',
    //   },
    // },

    /**
     * AI Configuration (Bedrock)
     * Amazon Bedrock for AI/ML model access
     */
    // ai: {
    //   models: ['anthropic.claude-3-5-sonnet-20241022-v2:0'],
    //   allowStreaming: true,
    //   service: 'ecs', // 'ecs' | 'ec2' | 'lambda'
    // },

    /**
     * Tunnel Configuration
     *
     * Deploy a custom tunnel server for `buddy share`.
     * Only needed if you want your own tunnel domain — localtunnel.dev
     * is the shared Stacks default and requires no deployment.
     *
     * Set enabled: true and provide a custom domain to deploy a
     * dedicated tunnel server via `buddy deploy:tunnel`.
     */
    // tunnel: {
    //   enabled: false,
    //   // domain: 'tunnel.mycompany.com',  // must NOT be localtunnel.dev
    //   // region: 'us-east-1',
    //   // ssl: { enabled: true },
    // },

    /**
     * Monitoring Configuration (optional)
     */
    monitoring: {
      // Uncomment to add alarms
      // alarms: {
      //   'high-cpu': {
      //     metricName: 'CPUUtilization',
      //     namespace: 'AWS/EC2',
      //     threshold: 80,
      //     comparisonOperator: 'GreaterThanThreshold',
      //   },
      // },
    },
  },

  /**
   * Sites Configuration (optional)
   * For multi-site deployments
   *
   * Site kinds (resolved by ts-cloud's `resolveSiteKind`):
   *  - `server` + `start`  → server-app  (systemd service behind the reverse proxy)
   *  - `server` + no `start` (has `root`) → server-static (built locally, shipped
   *    to `/var/www/<siteName>`, served by the reverse proxy's `file_server`)
   *  - `bucket`            → upload built `root` to object storage + CDN
   *
   * The three static sites below (`docs`, `blog`, `public`) are the Hetzner
   * server-static replacement for the AWS website-hosting buckets in
   * `infrastructure.storage` (see the supersede note there). `buddy deploy`'s
   * Hetzner path (`deployAllComputeSites`) builds each site's `root`, tars it,
   * and ships it to `/var/www/<siteName>` on the box. No new Hetzner buckets are
   * created. Each site's key maps 1:1 to `/var/www/<key>`:
   *   - `docs`   → /var/www/docs   → served at /docs   on stacksjs.com
   *   - `blog`   → /var/www/blog   → served at /blog   on stacksjs.com
   *   - `public` → /var/www/public → served at /        on stacksjs.com
   */
  /**
   * Sites
   *
   * Public services are systemd units on the shared box. Ports matter here in
   * a way they do not on a dedicated server: eleven projects share this
   * machine, and 3000/3001/3010/3011/3024/3032/3040/3049/3060/3100 are
   * already claimed by other tenants (plus each one's `+1`/`+8` sidecar).
   * 3070/3071/3072 are reserved for this app. Picking an occupied port does not
   * fail loudly — the second service simply cannot bind, and the tenant that
   * was already there keeps serving. Background roles are deliberately
   * portless so ts-cloud health-checks their systemd process rather than an
   * HTTP socket they do not provide.
   */
  sites: {
    main: {
      root: '.',
      path: '/',
      domain: 'predicthq.org',
      // Raw provider documents are immutable evidence and must outlive the
      // release that fetched them. ts-cloud links this directory through the
      // site's shared storage on every atomic deploy.
      sharedPaths: ['storage/ingest'],
      // Point at the installed CLI's built entry, NOT the `./buddy` shim.
      // ts-cloud runs `start` under bun, so `./buddy serve` becomes
      // `bun ./buddy serve` — and `buddy` is a shell script, which bun tries
      // to BUNDLE. It fails with "3 errors building .../buddy" and the
      // service restart-loops. The shim is for humans at a terminal; a
      // systemd unit wants the entry the shim would have resolved to.
      start: 'bun node_modules/@stacksjs/buddy/dist/cli.js serve',
      port: 3070,
      /*
       * Sized from what this service actually does, not from a default.
       *
       * Measured on the production host: 774M resident, 997M peak, and never
       * once throttled. 2G is a shade over twice the worst seen, which is the
       * right shape for a ceiling whose job is to contain a runaway rather
       * than to ration a healthy process.
       *
       * Declaring it is now more important than it used to be. ts-cloud's
       * default became `auto` (an eighth of host RAM), which resolves to
       * ~1951M on this 15.6G box but would land well UNDER this service's
       * 997M peak on a smaller one - and a ceiling below the working set is
       * how a service ends up throttled into uninterruptible sleep rather
       * than merely slow.
       */
      memoryHigh: '2G',
      memoryMax: '2560M',
      preStart: [
        'bun install',
        'bun node_modules/@stacksjs/buddy/dist/cli.js preflight --production',
        // The main service owns schema migration. Both processes connect to
        // the same vtgate keyspace, so the API must never race this step.
        'bun node_modules/@stacksjs/buddy/dist/cli.js migrate',
        // These model fixtures are canonical provider metadata, not sample
        // rows. The seeder skips populated tables, making fresh installs and
        // ordinary deploys equally safe and idempotent.
        'bun node_modules/@stacksjs/buddy/dist/cli.js seed --only Sport,Bookmaker',
      ],
      // Where `main` proxies /api is declared in productionRuntimeEnv so all
      // private roles share one explicit internal API target.
      env: productionRuntimeEnv,
      // Scheduling belongs to the realtime service below. Leaving this
      // implicit starts a second scheduler daemon and makes both processes
      // race over the same market rows.
      scheduler: false,
    },

    // Reached only through main's same-origin /api proxy. No `domain`, so
    // the rpx gateway skips it and the deploy strips its port from the
    // firewall — the HOST bind below is then a second lock, not the only one.
    api: {
      root: '.',
      start: 'bun node_modules/@stacksjs/actions/dist/serve/api.js',
      port: 3071,
      // 84M resident, 200M peak, never throttled. 512M is ~2.5x the worst
      // seen and a quarter of what it was silently holding before.
      memoryHigh: '512M',
      memoryMax: '768M',
      preStart: ['bun install'],
      // Same keyspace as `main`, and no migrate step: one schema owner.
      env: {
        ...productionRuntimeEnv,
        HOST: '127.0.0.1',
      },
    },

    // The realtime socket and scheduler deliberately share one process.
    // Stacks broadcasts use a process-local server instance, so this is what
    // lets a completed scheduled ingest push immediately to subscribers. It
    // also leaves exactly one scheduler daemon writing market data.
    scheduler: {
      root: '.',
      domain: 'realtime.predicthq.org',
      start: 'bun app/Runtimes/RealtimeScheduler.ts',
      port: 3072,
      healthCheck: { path: '/health' },
      // 331M resident, 466M peak, never throttled.
      memoryHigh: '1G',
      memoryMax: '1536M',
      sharedPaths: ['storage/ingest'],
      preStart: ['bun install'],
      env: productionRuntimeEnv,
    },
    // The remaining long-lived roles have no public domain; ts-cloud manages
    // them as systemd services, while rpx exposes no route or firewall port.
    worker: {
      root: '.',
      start: 'bun node_modules/@stacksjs/buddy/dist/cli.js queue:work --concurrency 2',
      // 94M resident, 382M peak, never throttled. The peak is what matters
      // here rather than the resident figure: this runs two jobs at once, so
      // its high-water mark is set by the largest pair it has had in hand.
      memoryHigh: '1G',
      memoryMax: '1536M',
      sharedPaths: ['storage/ingest'],
      preStart: ['bun install'],
      env: productionRuntimeEnv,
    },
    oddsWatcher: {
      root: '.',
      start: 'bun node_modules/@stacksjs/buddy/dist/cli.js odds:watch',
      // 195M resident, 219M peak, never throttled. A long-lived poller with a
      // flat profile, so it needs the least of the five.
      memoryHigh: '512M',
      memoryMax: '768M',
      sharedPaths: ['storage/ingest'],
      preStart: ['bun install'],
      env: productionRuntimeEnv,
    },
  },
}

// Stacks cloud configuration (for existing Stacks cloud features)
const config: CloudConfig = {
  // Add Stacks-specific cloud config here if needed
}

export default config
