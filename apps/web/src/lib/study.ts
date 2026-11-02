import type { InterviewMode } from '@orvia/shared';
import { HR_GROUPS } from './studyHr';
import { BEHAVIOURAL_GROUPS } from './studyBehavioural';
import { STUDY_TABS } from './studyModes';

/**
 * Mode study guides covering foundational concepts in recommended learning order.
 * Content is kept general and independent of specific bank questions and rubrics.
 * IDs are unique across guides and persist read/known state in localStorage.
 */

export type Concept = {
  id: string;
  title: string;
  /** In the short set to refresh in the ten minutes before a round. */
  core?: boolean;
  /** What it is, in one line. */
  what: string;
  /** What it does and why it exists. */
  does: string;
  /** Signals in a problem that should make you reach for it. */
  reachWhen: string[];
  /** What it costs, and how it fails. */
  tradeoffs: string[];
  /** The figures worth knowing by heart, when there are any. */
  numbers?: string;
  /** One sentence to say in the round. */
  say: string;
  /** Test yourself before you tick it. */
  check: { q: string; a: string };
  related?: string[];
};

export type ConceptGroup = { id: string; title: string; lead: string; concepts: Concept[] };

/** Section headings on a card. "What it costs" reads oddly on a salary card. */
export type GuideLabels = Record<'does' | 'reachWhen' | 'tradeoffs' | 'numbers' | 'say' | 'check', string>;

export type StudyGuide = {
  mode: InterviewMode;
  tab: string;
  title: string;
  intro: string;
  labels: GuideLabels;
  groups: ConceptGroup[];
  /** The button at the end, which opens setup on this mode. */
  start: string;
};

const DESIGN_GROUPS: ConceptGroup[] = [
  {
    id: 'method',
    title: 'The method',
    lead: 'Before any component: how to pin down what you are building and how big it is. A design is only as good as the numbers it was sized against.',
    concepts: [
      {
        id: 'requirements',
        title: 'Functional and non-functional requirements',
        core: true,
        what: 'Functional requirements say what the system DOES; non-functional ones say what it must WITHSTAND.',
        does: 'They turn a vague prompt into a bounded problem. Functional: "users can post, follow, and see a feed". Non-functional: availability, latency, consistency, durability, scale. Almost every later choice traces back to a non-functional requirement — you pick a cache because of a latency target, a queue because of a burst, a replica because of an availability target.',
        reachWhen: ['The first three minutes of every design round.', 'Any time you are about to pick a technology and cannot say which requirement it serves.'],
        tradeoffs: [
          'Too many functional requirements and you run out of time. Three or four, then name what is out of scope.',
          'Non-functional targets you never state cannot justify anything later — write them down with numbers.',
        ],
        say: 'Functionally it needs to do three things: <...>. Non-functionally I will assume high availability, reads under two hundred milliseconds, and eventual consistency for <the part that can tolerate it>.',
        check: {
          q: 'Name four non-functional requirements and one design choice each one could force.',
          a: 'Availability → replicas and failover. Latency → caching or a CDN. Consistency → a single leader or transactions. Durability → replication and backups. Throughput → sharding or queues.',
        },
        related: ['estimation', 'cap'],
      },
      {
        id: 'estimation',
        title: 'Back-of-the-envelope estimation',
        core: true,
        what: 'Rough arithmetic for requests per second, storage and bandwidth, to one significant figure.',
        does: 'It tells you which parts of the design are hard. A thousand writes a second fits on one database; a million does not. The point is not the exact number — it is finding which resource (CPU, storage, bandwidth, memory) is the wall.',
        reachWhen: ['Right after requirements.', 'Whenever you claim something "will not scale" — back it with a number.'],
        tradeoffs: ['Precision wastes time. Round aggressively and say you are rounding.', 'Forgetting peak: plan for two to three times the average.'],
        numbers: 'A day is about 100,000 seconds (86,400). 1 million requests a day ≈ 12 per second. 100 million a day ≈ 1,200 per second. 1 KB × 1 million = 1 GB. A year is about 400 days for rounding.',
        say: 'One hundred million daily users, ten reads each, is a billion reads a day — about twelve thousand a second, so call it thirty-five thousand at peak.',
        check: {
          q: '500 million new records a day, 1 KB each. How much storage per year, roughly?',
          a: '500 GB a day, times about 400 days ≈ 200 TB a year before replication — around 600 TB with three replicas.',
        },
        related: ['latency-numbers', 'requirements'],
      },
      {
        id: 'latency-numbers',
        title: 'Latency numbers worth knowing',
        what: 'The rough cost of memory, disk, and network operations, by order of magnitude.',
        does: 'They let you reason about where time goes without measuring. They are why caches exist (memory is a thousand times faster than a network hop to a database) and why cross-region calls get designed out of the hot path.',
        reachWhen: ['Justifying a cache.', 'Deciding whether a call can happen synchronously inside a request.', 'Any multi-region design.'],
        tradeoffs: ['These are orders of magnitude, not benchmarks — say "roughly".'],
        numbers: 'Memory read: ~100 ns. SSD random read: ~100 µs. Round trip in one datacentre: ~0.5 ms. Disk seek: ~10 ms. Cross-continent round trip: ~150 ms.',
        say: 'A round trip to the database is around a millisecond inside the datacentre, while a memory read is nanoseconds, so caching the hot keys takes most of the latency out of the read path.',
        check: { q: 'Why might you avoid calling a service in another region inside a user request?', a: 'A cross-continent round trip is ~150 ms on its own — most of a typical 200 ms latency budget, before any work is done.' },
        related: ['caching', 'cdn'],
      },
      {
        id: 'api-design',
        title: 'API design',
        what: 'The contract between client and server: endpoints, parameters, responses, and errors.',
        does: 'Defining the API early forces you to pin down what the system actually does, and it shapes the data model. REST over HTTP is the default; gRPC suits internal service-to-service calls; GraphQL suits clients that need flexible queries across many entities.',
        reachWhen: ['Straight after estimation, before drawing components.', 'Anything returning a long list — it needs pagination.', 'Any write a client might retry — it needs an idempotency key.'],
        tradeoffs: [
          'Offset pagination (`?page=5`) is simple but slow deep in the list and skips items when rows are inserted; cursor pagination (`?after=<id>`) is stable and fast.',
          'Chatty APIs (many small calls per screen) multiply latency on mobile networks.',
        ],
        say: 'The core endpoints are a POST to create, a GET by id, and a paginated GET for the list, using a cursor rather than an offset so the list stays stable as new items arrive.',
        check: { q: 'Why is cursor pagination preferred over offset pagination for a feed?', a: 'New items shift offsets, so offset paging repeats or skips items, and a large offset forces the database to scan and discard rows. A cursor resumes from a known position.' },
        related: ['idempotency', 'rate-limiting'],
      },
    ],
  },

  {
    id: 'request-path',
    title: 'The request path',
    lead: 'What sits between a user and your code. Follow one request from the browser to the service and back.',
    concepts: [
      {
        id: 'cdn',
        title: 'DNS and CDNs',
        core: true,
        what: 'DNS turns a name into an address; a CDN serves content from servers close to the user.',
        does: 'A CDN caches static and media content (images, video, scripts) at edge locations worldwide, so most requests never reach your servers. That cuts latency for users far away and removes most bandwidth cost from your origin. DNS can also route users to the nearest region.',
        reachWhen: ['Images, video, or any large static file.', 'A global user base.', 'Read-heavy content that is the same for many users.'],
        tradeoffs: [
          'Invalidation is slow and coarse — use versioned file names (`logo.v42.png`) rather than purging.',
          'Poor fit for personalised or rapidly changing responses.',
        ],
        say: 'Media goes to object storage and is served through a CDN, so the origin only handles metadata and the edge absorbs the bandwidth.',
        check: { q: 'How do you update a file the CDN has cached for a week?', a: 'Publish it under a new versioned name and point the page at that; the old name simply expires. Purging works but is slow and does not reach every edge at once.' },
        related: ['object-storage', 'caching'],
      },
      {
        id: 'load-balancer',
        title: 'Load balancers',
        core: true,
        what: 'A component that spreads incoming requests across a pool of servers.',
        does: 'It lets you add servers to handle more load, and it routes around servers that fail health checks, so one dead machine does not become an outage. Layer 4 balancers route by IP and port and are very fast; layer 7 balancers understand HTTP and can route by path, header or cookie.',
        reachWhen: ['More than one server behind anything.', 'Any availability requirement — it is what makes a server replaceable.'],
        tradeoffs: [
          'Round-robin is simple; least-connections handles uneven request costs better.',
          'Sticky sessions tie a user to one server and undo most of the benefit — keep services stateless instead.',
          'The balancer itself must be redundant, or it becomes the single point of failure.',
        ],
        say: 'The service tier is stateless behind a layer-seven load balancer, so I can add instances as traffic grows and a failed instance just drops out of the health check.',
        check: { q: 'Why do sticky sessions make scaling and failover harder?', a: 'State lives on one server, so load cannot be rebalanced freely and that user loses their session if the server dies. Moving session state to a shared store keeps servers interchangeable.' },
        related: ['stateless', 'api-gateway'],
      },
      {
        id: 'stateless',
        title: 'Stateless services and horizontal scaling',
        core: true,
        what: 'A stateless service keeps nothing between requests on the server itself, so any instance can handle any request.',
        does: 'This is what makes horizontal scaling (adding more machines) work. Session data, uploads and caches move to shared stores — a database, Redis, object storage — and the service becomes a pure function of request plus shared state. Vertical scaling (a bigger machine) is simpler but has a ceiling and a single point of failure.',
        reachWhen: ['Designing any application tier.', 'The interviewer asks "how do you scale this?"'],
        tradeoffs: ['The state does not disappear, it moves — now the shared store has to scale.', 'Each request may need an extra hop to fetch state.'],
        say: 'I will keep the API servers stateless and put sessions in Redis, so scaling the tier is just adding instances.',
        check: { q: 'What is the difference between vertical and horizontal scaling, and when is vertical fine?', a: 'Vertical is a bigger machine; horizontal is more machines. Vertical is fine early or for components hard to distribute — often the primary database — until it hits its ceiling.' },
        related: ['load-balancer', 'sharding'],
      },
      {
        id: 'api-gateway',
        title: 'API gateways',
        what: 'A single entry point in front of many services that handles cross-cutting concerns.',
        does: 'Authentication, rate limiting, request routing to the right service, TLS termination, and logging live in one place instead of being reimplemented in every service. Common in microservice designs.',
        reachWhen: ['Several backend services behind one public API.', 'Auth or rate limiting needed on every route.'],
        tradeoffs: ['Another hop and another component that must stay up.', 'It tempts teams into putting business logic there — keep it thin.'],
        say: 'Clients hit an API gateway that handles auth and rate limiting, then routes to the post, feed and user services behind it.',
        check: { q: 'Name three things a gateway handles so the services do not have to.', a: 'Any three of: authentication, rate limiting, routing, TLS termination, request logging, request or response transformation.' },
        related: ['rate-limiting', 'load-balancer'],
      },
      {
        id: 'rate-limiting',
        title: 'Rate limiting',
        what: 'Capping how many requests a client may make in a time window.',
        does: 'It protects the system from abuse, runaway clients and traffic spikes, and enforces fair use. Common algorithms: token bucket (allows bursts up to a bucket size, refills at a steady rate), leaky bucket (smooths output to a fixed rate), fixed window (simple, but allows double bursts at window edges), and sliding window (accurate, more memory).',
        reachWhen: ['Any public API.', 'Expensive endpoints such as login, search, or sending messages.', 'Protecting a downstream dependency that cannot absorb bursts.'],
        tradeoffs: [
          'Across many servers the counters must live in a shared store such as Redis, which adds a hop per request.',
          'Fail open (allow when the limiter is down) or fail closed (reject) is a real decision — say which and why.',
        ],
        say: 'I would use a token bucket per user, counters in Redis with a TTL, which allows short bursts but caps the sustained rate, and returns a 429 with a retry-after header.',
        check: { q: 'What is the weakness of a fixed-window limiter?', a: 'A client can send the full limit at the end of one window and again at the start of the next — double the intended rate in a short span.' },
        related: ['api-gateway', 'caching'],
      },
    ],
  },

  {
    id: 'storage',
    title: 'Storing data',
    lead: 'Where the data lives, and why that store. Start from the access pattern — how the data is read — never from the product name.',
    concepts: [
      {
        id: 'sql-nosql',
        title: 'SQL or NoSQL',
        core: true,
        what: 'Relational databases store rows in tables with a fixed schema and joins; NoSQL stores trade some of that for scale or flexibility.',
        does: 'Relational databases (Postgres, MySQL) give you transactions, joins and strong consistency — the right default for most data with relationships. NoSQL is a family: key-value (Redis, DynamoDB) for lookups by key; wide-column (Cassandra) for huge write volumes partitioned by key; document (MongoDB) for nested, flexible records; graph (Neo4j) for relationship traversal.',
        reachWhen: ['Choosing a store for every entity in your data model.', 'Massive write throughput with simple access by key → wide-column.', 'Money, inventory, anything needing transactions → relational.'],
        tradeoffs: [
          'Relational scales writes poorly past one machine without sharding.',
          'Most NoSQL stores make you design tables around your queries, so a new query pattern can mean a new table.',
        ],
        say: 'The access pattern is always "fetch messages for a conversation, newest first", which is a partition key plus a sort key, so a wide-column store fits better than relational here.',
        check: { q: 'You need to store payments and account balances. Which family, and why?', a: 'Relational — balances need atomic transactions across rows and strong consistency, and losing or double-applying a write is unacceptable.' },
        related: ['indexes', 'sharding', 'transactions'],
      },
      {
        id: 'indexes',
        title: 'Indexes',
        what: 'An extra data structure that lets the database find rows without scanning the whole table.',
        does: 'Most databases use a B-tree index: sorted, so it supports exact lookups and range queries in logarithmic time. Write-heavy stores often use LSM trees, which buffer writes in memory and flush them to disk in sorted batches — fast writes, slower reads. A composite index on (a, b) serves queries filtering on a, or on a and b, but not on b alone.',
        reachWhen: ['Any query that filters or sorts on a column.', 'A slow-query question in the deep dive.'],
        tradeoffs: ['Every index slows writes and takes storage, because each write must update it.', 'An index on a low-selectivity column (a boolean) rarely helps.'],
        say: 'I would put a composite index on user id and created-at, so "this user\'s latest posts" is an index range scan rather than a table scan.',
        check: { q: 'An index exists on (user_id, created_at). Does it help a query filtering only on created_at?', a: 'Not as a seek — the index is sorted by user_id first, so created_at values are scattered across it.' },
        related: ['sql-nosql', 'search'],
      },
      {
        id: 'object-storage',
        title: 'Object storage',
        what: 'A store for large binary files — images, video, backups — addressed by key, such as S3 or R2.',
        does: 'It is cheap, effectively unlimited, and very durable. Databases should hold metadata and a pointer (the key); the bytes go to object storage. Clients can upload directly using a pre-signed URL, so large files never pass through your servers.',
        reachWhen: ['Anything a user uploads.', 'Media, logs or backups.'],
        tradeoffs: ['Higher latency than a database, so put a CDN in front for reads.', 'No partial updates — you rewrite the whole object.'],
        say: 'The client gets a pre-signed URL and uploads the video straight to object storage; the database only stores the key and the metadata.',
        check: { q: 'Why upload directly to object storage with a pre-signed URL instead of through your API?', a: 'Large files would tie up API servers and their bandwidth for the whole transfer. A pre-signed URL grants time-limited permission for that one object, so the bytes go straight to storage.' },
        related: ['cdn'],
      },
    ],
  },

  {
    id: 'scaling-data',
    title: 'Scaling the data',
    lead: 'When one database is not enough. Replication copies the data to serve more reads; sharding splits it to serve more writes.',
    concepts: [
      {
        id: 'replication',
        title: 'Replication',
        core: true,
        what: 'Keeping copies of the same data on several machines.',
        does: 'It gives you availability (a copy survives a machine dying) and read scale (reads spread across replicas). Leader-follower: all writes go to one leader, which streams them to followers that serve reads. Multi-leader and leaderless setups accept writes in several places, at the cost of resolving conflicts.',
        reachWhen: ['A read-heavy workload.', 'Any availability requirement on the data tier.'],
        tradeoffs: [
          'Asynchronous replication means replica lag: a user may not see their own write if the read lands on a stale follower.',
          'Synchronous replication avoids that but makes every write wait on the slowest replica.',
          'Failover can lose writes the old leader had not yet replicated.',
        ],
        say: 'Writes go to the primary, reads to replicas. To avoid a user missing their own post, I would route that user\'s reads to the primary for a few seconds after they write.',
        check: { q: 'A user posts a comment, refreshes, and it is missing. What happened, and what is one fix?', a: 'Their read hit a replica that had not yet received the write. Read-your-writes: route that user to the leader briefly after a write, or read from a replica known to be caught up.' },
        related: ['sharding', 'consistency-models'],
      },
      {
        id: 'sharding',
        title: 'Sharding (partitioning)',
        core: true,
        what: 'Splitting one dataset across several databases, each holding a subset of the rows.',
        does: 'It scales writes and storage beyond one machine. A shard key decides which shard a row lives on — usually by hashing it (even spread) or by range (good for range scans, risky for hot spots).',
        reachWhen: ['Writes or storage beyond what one machine handles.', 'Your estimate shows terabytes, or tens of thousands of writes a second.'],
        tradeoffs: [
          'Queries that do not include the shard key must ask every shard.',
          'A hot key (a celebrity, a viral item) can overload one shard however many you add.',
          'Cross-shard transactions and joins become hard or impossible.',
          'Re-sharding later is expensive — choose the key carefully.',
        ],
        say: 'I would shard messages by conversation id: every query for a conversation hits one shard, and hashing the id spreads conversations evenly.',
        check: { q: 'Why is sharding users by sign-up date usually a bad key?', a: 'All new writes land on the newest shard (a hot spot), and the older shards sit nearly idle.' },
        related: ['consistent-hashing', 'replication'],
      },
      {
        id: 'consistent-hashing',
        title: 'Consistent hashing',
        what: 'A way to map keys to nodes so that adding or removing a node moves only a small fraction of keys.',
        does: 'With plain `hash(key) % N`, changing N remaps almost every key — a cache would lose nearly everything at once. Consistent hashing places nodes and keys on a ring; each key belongs to the next node clockwise. Adding a node only takes keys from its neighbour. Virtual nodes (many points per server) keep the load even.',
        reachWhen: ['Distributed caches.', 'Sharded stores that need to add nodes without a big reshuffle.'],
        tradeoffs: ['Without virtual nodes the spread is uneven.', 'More complex than modulo, which is fine for a fixed shard count.'],
        say: 'I would place cache nodes on a consistent-hash ring with virtual nodes, so adding a node only moves about one-Nth of the keys instead of nearly all of them.',
        check: { q: 'With 4 cache nodes and hash-mod-N, roughly what fraction of keys move when a fifth is added?', a: 'About 80% — most keys change node. With consistent hashing, about 20%.' },
        related: ['sharding', 'caching'],
      },
    ],
  },

  {
    id: 'caching',
    title: 'Caching',
    lead: 'The cheapest way to make reads fast and the easiest way to serve wrong data. Every cache is a decision about how stale is acceptable.',
    concepts: [
      {
        id: 'caching',
        title: 'Caching strategies',
        core: true,
        what: 'Keeping a copy of frequently read data in fast storage, usually memory (Redis, Memcached).',
        does: 'Cache-aside (the default): read the cache; on a miss, read the database and fill the cache. Write-through: write to cache and database together — always fresh, slower writes. Write-back: write to the cache and flush later — fast, but data is lost if the cache dies. Eviction (usually LRU) decides what goes when memory is full; a TTL bounds staleness.',
        reachWhen: ['Read-heavy data — a high read-to-write ratio.', 'Expensive computations or aggregates read often.', 'A latency target the database cannot meet alone.'],
        tradeoffs: [
          'Stale reads: the cache and database disagree until the TTL or an invalidation.',
          'Invalidation on write is easy to get wrong — usually delete the key, rather than update it.',
          'A cold cache after a restart sends the full load to the database.',
        ],
        say: 'Cache-aside in Redis with a five-minute TTL. On a write I delete the key rather than update it, so the next read refills it from the database.',
        check: { q: 'Why delete a cache key on write instead of writing the new value into it?', a: 'Two concurrent writers can update the database and cache in different orders and leave the cache permanently stale. Deleting forces the next read to fetch the current value.' },
        related: ['cache-stampede', 'cdn', 'latency-numbers'],
      },
      {
        id: 'cache-stampede',
        title: 'Cache stampedes and hot keys',
        what: 'A popular key expires, and many requests miss at once and hit the database together.',
        does: 'Fixes: let only one request recompute while others wait or get the stale value (request coalescing, a lock), refresh hot keys before they expire, and add random jitter to TTLs so keys do not expire together. A single hot key can also overload one cache node — replicate it, or keep a small local cache in each server.',
        reachWhen: ['The deep dive on any cache.', 'A celebrity, a viral post, or a homepage everyone loads.'],
        tradeoffs: ['Serving stale-while-revalidating means some users see old data briefly.', 'Locks add latency to the request that does the recompute.'],
        say: 'To stop a stampede when a hot key expires, only one request recomputes it and the rest serve the stale value until it is back.',
        check: { q: 'Name two ways to prevent a cache stampede.', a: 'Any two of: request coalescing or a lock so one request refills, serving stale while refreshing, refreshing early, randomised TTL jitter.' },
        related: ['caching'],
      },
    ],
  },

  {
    id: 'async',
    title: 'Async work and messaging',
    lead: 'Not everything has to finish before you answer the user. Queues decouple the parts of a system so a slow or broken one does not stall the rest.',
    concepts: [
      {
        id: 'queues',
        title: 'Message queues',
        core: true,
        what: 'A buffer where producers drop tasks and workers pick them up later (SQS, RabbitMQ).',
        does: 'The request returns as soon as the task is queued; workers process it in the background. That absorbs traffic bursts, lets you scale workers separately, and retries failed tasks. A dead-letter queue holds tasks that keep failing so they do not block the rest.',
        reachWhen: ['Slow work the user need not wait for: sending email, encoding video, generating thumbnails.', 'Bursty traffic hitting a component with fixed capacity.', 'Retrying calls to an unreliable dependency.'],
        tradeoffs: [
          'Eventual: the result is not ready when the request returns.',
          'Most queues deliver at least once, so workers must be idempotent.',
          'A growing backlog is a silent failure — alert on queue depth and age.',
        ],
        say: 'The upload request returns once the video is stored and a job is queued; a pool of encoder workers drains the queue and we scale them on queue depth.',
        check: { q: 'What is a dead-letter queue for?', a: 'Messages that fail repeatedly are moved there after N attempts, so one poison message does not block or endlessly retry, and someone can inspect it.' },
        related: ['streams', 'idempotency'],
      },
      {
        id: 'streams',
        title: 'Pub/sub and event streams',
        what: 'Publishing an event once so many independent consumers can react to it (Kafka, Kinesis, Pub/Sub).',
        does: 'A queue hands each task to one worker; a stream keeps an ordered, durable log that many consumer groups read at their own pace and can replay. Kafka splits a topic into partitions: order is guaranteed only within a partition, so you choose a partition key (for example user id) to keep related events in order.',
        reachWhen: ['One event with several reactions: notify, update the search index, update analytics.', 'Activity feeds, logs, metrics, change-data-capture.', 'Needing to replay history into a new consumer.'],
        tradeoffs: ['No global ordering across partitions.', 'The number of partitions caps how many consumers in a group can work in parallel.', 'More to operate than a simple queue.'],
        say: 'When a post is created we publish one event; the feed, search and notification services each consume it independently, partitioned by user id so one user\'s events stay in order.',
        check: { q: 'Why does the partition key matter in Kafka?', a: 'Ordering is only guaranteed within a partition, and the key decides the partition. Events that must stay in order need the same key — and a skewed key creates a hot partition.' },
        related: ['queues', 'fanout'],
      },
      {
        id: 'idempotency',
        title: 'Idempotency and delivery guarantees',
        core: true,
        what: 'An operation is idempotent if doing it twice has the same effect as doing it once.',
        does: 'Networks fail mid-request, so clients retry and queues redeliver. Delivery is at-most-once (may lose), at-least-once (may duplicate), or "exactly-once", which in practice means at-least-once delivery plus idempotent processing. The usual tool is an idempotency key: the client sends a unique id with the request, and the server records it and returns the first result for any repeat.',
        reachWhen: ['Payments, orders, anything that must not happen twice.', 'Any queue consumer.', 'Any client that retries.'],
        tradeoffs: ['You must store keys for some window, and check them atomically with the write.', 'Claiming exactly-once delivery over a network is a red flag — explain the dedupe instead.'],
        say: 'The client sends an idempotency key with the payment; we store it with a unique constraint, so a retry returns the original result rather than charging twice.',
        check: { q: 'A queue guarantees at-least-once delivery. How do you avoid sending a user two emails?', a: 'Make the consumer idempotent: record a processed-message id (or a natural key such as user + notification id) with a unique constraint and skip any message already recorded.' },
        related: ['queues', 'transactions', 'retries'],
      },
      {
        id: 'fanout',
        title: 'Fan-out on write versus on read',
        what: 'Two ways to build a per-user view such as a feed or an inbox.',
        does: 'Fan-out on write (push): when someone posts, copy the post id into every follower\'s precomputed feed. Reads are instant, writes are expensive. Fan-out on read (pull): build the feed at read time by fetching from everyone the user follows. Writes are cheap, reads are slow. Real systems mix them — push for most accounts, pull for accounts with millions of followers.',
        reachWhen: ['Feeds, timelines, inboxes, notifications to many recipients.'],
        tradeoffs: ['Push: one post by a huge account means millions of writes.', 'Pull: every feed load queries many sources and merges them.', 'Hybrid: more complex, but the usual answer at scale.'],
        say: 'I would fan out on write for normal accounts so reads are a single cache lookup, and fan out on read for very large accounts, merging their posts in at read time.',
        check: { q: 'Why not fan out on write for an account with fifty million followers?', a: 'Each post would trigger fifty million feed writes — a huge, slow burst that delays everyone else\'s posts and wastes work on inactive followers.' },
        related: ['streams', 'caching'],
      },
    ],
  },

  {
    id: 'consistency',
    title: 'Consistency and correctness',
    lead: 'What happens when copies disagree or a failure lands halfway through an operation. Say what can go wrong, and how much of it the feature can tolerate.',
    concepts: [
      {
        id: 'cap',
        title: 'CAP and PACELC',
        core: true,
        what: 'During a network partition, a distributed store must choose between consistency and availability.',
        does: 'CAP: when part of the network is cut off (P), you either refuse some requests to stay correct (C) or answer with possibly stale data to stay up (A). Partitions are not optional, so the real choice is C or A while one is happening. PACELC adds the everyday case: even with no partition, there is a trade-off between latency (L) and consistency (C).',
        reachWhen: ['Justifying a database choice.', 'Any "what happens if a region is cut off?" question.'],
        tradeoffs: ['Choose per feature, not per system: a like count can be eventually consistent; a bank balance cannot.'],
        say: 'For likes and view counts I would choose availability and accept eventual consistency; for payments I need consistency, even if that means rejecting writes during a partition.',
        check: { q: 'Why is "CA" not a real option for a distributed system?', a: 'Network partitions will happen. CA only describes a system that never partitions — effectively one machine.' },
        related: ['consistency-models', 'replication'],
      },
      {
        id: 'consistency-models',
        title: 'Consistency models',
        what: 'The guarantees a system gives about what a read can return after a write.',
        does: 'Strong (linearisable): every read sees the latest write, as if there were one copy. Eventual: replicas converge if writes stop, but a read may be stale meanwhile. In between, the useful guarantees: read-your-writes (you always see your own writes), monotonic reads (you never see data go backwards), and causal (an effect is never seen before its cause — a reply never before its message).',
        reachWhen: ['Any replicated data.', 'A question like "can the user see stale data?"'],
        tradeoffs: ['Stronger guarantees need coordination, which costs latency and availability.', 'Many user-facing bugs only need read-your-writes, not full strong consistency.'],
        say: 'Global strong consistency is not needed here — read-your-writes covers the case users notice, which is posting and not seeing it.',
        check: { q: 'In a chat app, which guarantee stops a reply appearing before the message it answers?', a: 'Causal consistency — it preserves cause-before-effect ordering.' },
        related: ['cap', 'replication'],
      },
      {
        id: 'transactions',
        title: 'Transactions across services',
        what: 'Keeping data correct when one action changes several databases or services.',
        does: 'Inside one database, an ACID transaction makes a set of writes all-or-nothing. Across services there is no shared transaction. Two-phase commit coordinates one but blocks if the coordinator fails, so it is rarely used. A saga runs a chain of local transactions, with a compensating action to undo each step if a later one fails. The outbox pattern writes the event to an outbox table in the same transaction as the data, and a relay publishes it, so a database write and its event cannot diverge.',
        reachWhen: ['An order touching payment, inventory and shipping.', 'Writing to a database AND publishing an event.'],
        tradeoffs: ['Sagas are eventually consistent and compensations must be designed per step.', 'The outbox adds a relay process and some delay.'],
        say: 'Saving the order and publishing the event happen together via an outbox table in the same transaction, so we never charge without an event or emit an event for an order that rolled back.',
        check: { q: 'Why not just write to the database and then publish to the queue in the service code?', a: 'The process can crash between the two, leaving a saved order with no event (or an event with no order). The outbox makes both one atomic database write.' },
        related: ['idempotency', 'sql-nosql'],
      },
    ],
  },

  {
    id: 'reliability',
    title: 'Staying up',
    lead: 'Every component fails eventually. The design question is what the user sees when it does, and how quickly you notice.',
    concepts: [
      {
        id: 'redundancy',
        title: 'Redundancy, failover and availability',
        what: 'Removing single points of failure by running more than one of everything that matters.',
        does: 'Availability is measured in nines: 99.9% allows about 8.8 hours of downtime a year; 99.99% about 53 minutes. You reach it with redundant instances behind load balancers, replicated databases with automatic failover, and multiple availability zones or regions. Active-active serves traffic from every copy; active-passive keeps a standby ready.',
        reachWhen: ['Stating an availability target.', 'Answering "what if this component dies?"'],
        tradeoffs: ['Each extra nine costs a lot more.', 'Multi-region adds replication lag and conflict handling.', 'Failover that is never tested often fails when it is needed.'],
        numbers: '99.9% ≈ 8.8 h/year. 99.99% ≈ 53 min/year. 99.999% ≈ 5 min/year.',
        say: 'Every tier runs in at least two availability zones; the database has a synchronous standby in another zone, so losing a zone costs a failover of seconds, not data.',
        check: { q: 'Roughly how much downtime a year does 99.99% availability allow?', a: 'About 53 minutes.' },
        related: ['load-balancer', 'replication'],
      },
      {
        id: 'retries',
        title: 'Timeouts, retries and circuit breakers',
        what: 'The rules for how one service calls another that might be slow or down.',
        does: 'Every remote call needs a timeout, or one slow dependency ties up all your threads. Retries recover from brief failures, but only with exponential backoff and jitter — otherwise every client retries at the same moment and the struggling service never recovers. A circuit breaker stops calling a failing dependency for a while and fails fast instead, so the failure does not spread.',
        reachWhen: ['Any service-to-service call.', 'A "what if the dependency is slow?" question.'],
        tradeoffs: ['Retrying a non-idempotent operation can apply it twice.', 'Retries at every layer multiply: three layers making three attempts each is twenty-seven calls.'],
        say: 'Calls to the payment provider have a two-second timeout, retry with exponential backoff and jitter on an idempotency key, and sit behind a circuit breaker so an outage there fails fast here.',
        check: { q: 'Why add jitter to retry backoff?', a: 'Without it, clients that failed together retry together, producing synchronised waves of load that keep the service down. Jitter spreads the retries out.' },
        related: ['idempotency', 'redundancy'],
      },
      {
        id: 'observability',
        title: 'Observability and percentiles',
        what: 'Metrics, logs and traces: how you know the system is healthy, and why it is not.',
        does: 'Metrics give trends and alerts (request rate, error rate, latency). Logs give detail on individual events. Distributed traces follow one request across services to show where time went. Latency is reported in percentiles: p50 is the typical request, p99 the slowest one in a hundred, and at scale p99 is what your heaviest users feel. An SLO is a target such as "99% of reads under 200 ms".',
        reachWhen: ['The end of a design: "how would you monitor this?"', 'Defining latency requirements.'],
        tradeoffs: ['High-cardinality metrics and verbose logs get expensive fast.', 'An average hides the slow tail — never quote a mean latency.'],
        say: 'I would track request rate, error rate and p99 latency per endpoint, alert on the SLO burning down rather than on single spikes, and trace requests across services.',
        check: { q: 'Why is average latency misleading?', a: 'A few very slow requests can hide behind a good mean, or skew it. Percentiles show the tail, and a page that makes many calls almost always hits the tail on at least one.' },
        related: ['redundancy'],
      },
    ],
  },

  {
    id: 'building-blocks',
    title: 'Building blocks that recur',
    lead: 'Specific techniques that come up again and again. Know what each is for, so you can name it when a problem needs it.',
    concepts: [
      {
        id: 'realtime',
        title: 'Real-time delivery: polling, long polling, SSE, WebSockets',
        what: 'Ways for a server to get new data to a client without the user refreshing.',
        does: 'Short polling: the client asks every few seconds — simple and wasteful. Long polling: the server holds the request open until there is news. Server-sent events: a one-way stream from server to client over HTTP. WebSockets: a persistent, two-way connection — the default for chat, live collaboration and games.',
        reachWhen: ['Chat, live notifications, presence, collaborative editing, live scores.'],
        tradeoffs: [
          'WebSockets are stateful: each server holds open connections, so you need a way to route a message to whichever server holds the recipient (a pub/sub layer or a connection registry).',
          'Mobile clients drop connections often — design for reconnect and catch-up.',
        ],
        say: 'Clients hold a WebSocket to a gateway tier; a registry in Redis maps each user to their gateway, so a message is routed to the right server and pushed down the open socket.',
        check: { q: 'With millions of WebSocket connections across many servers, how does a message reach the right one?', a: 'Keep a mapping of user to connection server (for example in Redis), or publish to a channel each gateway subscribes to, and forward it to the server holding that user\'s socket.' },
        related: ['streams', 'load-balancer'],
      },
      {
        id: 'search',
        title: 'Search and inverted indexes',
        what: 'An index mapping each word to the documents containing it — the structure behind full-text search (Elasticsearch, OpenSearch).',
        does: 'A database `LIKE \'%term%\'` scans every row. An inverted index looks up each term and intersects the lists, then ranks the results (for example by BM25, or by popularity). Text is tokenised and normalised (lower-cased, stemmed) on the way in. Typeahead is usually a separate structure: a trie or a prefix index of popular queries.',
        reachWhen: ['Full-text search, filtering on many fields, autocomplete.'],
        tradeoffs: ['The index is a second copy of the data that lags behind the source of truth — fed by events or change-data-capture.', 'Indexing is write-heavy and the cluster is costly to run.'],
        say: 'Postgres stays the source of truth; changes stream into Elasticsearch through events, so search is eventually consistent, typically within a second or two.',
        check: { q: 'Why is a separate search index usually eventually consistent?', a: 'It is updated asynchronously from the primary database — via events or change-data-capture — so there is a short lag between a write and it becoming searchable.' },
        related: ['indexes', 'streams'],
      },
      {
        id: 'unique-ids',
        title: 'Unique ID generation',
        what: 'Producing unique identifiers across many servers without a single bottleneck.',
        does: 'An auto-increment column works on one database but not across shards. UUIDs need no coordination, but they are large and random, which spreads index inserts badly. Snowflake-style ids pack a timestamp, a machine id and a sequence number into 64 bits: unique, roughly time-ordered, and generated locally. For short codes (a URL shortener) you can base-62 encode a counter or a range handed out to each server.',
        reachWhen: ['Sharded data.', 'Short links or codes.', 'Ids that should sort by creation time.'],
        tradeoffs: ['Time-based ids depend on reasonable clocks.', 'Sequential ids leak volume and are guessable.'],
        say: 'I would use Snowflake-style ids — timestamp, worker id and sequence — so every server generates them locally and they still sort by time.',
        check: { q: 'Why are random UUIDs a poor primary key for a B-tree-indexed table at high insert rates?', a: 'Random values land all over the index, causing page splits and poor cache locality. Time-ordered ids append near the end.' },
        related: ['sharding'],
      },
      {
        id: 'geo',
        title: 'Geospatial indexing',
        what: 'Structures for "what is near this point" queries: geohashes, quadtrees, and similar cell systems.',
        does: 'A geohash turns latitude and longitude into a string where a shared prefix means nearby, so a proximity search becomes a prefix lookup on the cell and its neighbours. A quadtree recursively splits space into four, so dense areas get smaller cells. Databases such as PostGIS and Redis provide geo indexes directly.',
        reachWhen: ['Ride-hailing, delivery, "near me" search, maps.'],
        tradeoffs: ['Points near a cell edge need the neighbouring cells checked too.', 'Moving objects mean a write-heavy index — often kept in memory.'],
        say: 'Drivers report their location every few seconds into an in-memory geo index keyed by geohash cell; a ride request searches its cell and the neighbouring cells.',
        check: { q: 'Why must a geohash search also check the neighbouring cells?', a: 'Two points can be very close but sit on opposite sides of a cell boundary, so their geohashes share no prefix.' },
        related: ['indexes', 'sharding'],
      },
      {
        id: 'batch-stream',
        title: 'Batch versus stream processing',
        what: 'Processing data in large scheduled chunks, or continuously as events arrive.',
        does: 'Batch jobs (Spark, nightly SQL) process everything since the last run: simple, cheap and easy to re-run, but hours stale. Stream processing (Flink, Kafka Streams) updates results within seconds of each event, with windows (for example "views per minute") and state. Many systems use both: streaming for live counts, batch to correct them later.',
        reachWhen: ['Analytics, counters, trending, recommendations, billing.'],
        tradeoffs: ['Streaming has to handle late and out-of-order events.', 'Batch is simpler to get right and to backfill.'],
        say: 'View counts update live from a stream with one-minute windows, and a nightly batch job reconciles them against the raw logs.',
        check: { q: 'Give one reason to keep a batch job even when you have a streaming pipeline.', a: 'To correct for late, duplicate or dropped events and to backfill after a bug — batch over the raw log gives the authoritative number.' },
        related: ['streams'],
      },
    ],
  },
];

export const STUDY_GUIDES: StudyGuide[] = [
  {
    mode: 'system_design',
    tab: STUDY_TABS.system_design!,
    title: 'System design concepts',
    intro: 'What a design round assumes you already know, in the order worth learning it. Each concept says what it is, what it does, when to reach for it and what it costs, then gives you one sentence to say in the round. Tick it once you can answer its check without looking.',
    labels: {
      does: 'What it does', reachWhen: 'Reach for it when', tradeoffs: 'What it costs',
      numbers: 'Numbers to know', say: 'Say it in the round', check: 'Check yourself',
    },
    groups: DESIGN_GROUPS,
    start: 'Set up a design round',
  },
  {
    mode: 'hr',
    tab: STUDY_TABS.hr!,
    title: 'Salary and offer negotiation',
    intro: 'What you need to know before anyone asks "what are your expectations?" — what an offer is made of, how companies decide the number, and how to hold yours when they push back. Written for offers in India, in LPA. Tick a card once you could say its line without reading it.',
    labels: {
      does: 'How it works', reachWhen: 'When it comes up', tradeoffs: 'Watch out for',
      numbers: 'The numbers', say: 'Say it', check: 'Check yourself',
    },
    groups: HR_GROUPS,
    start: 'Set up an HR round',
  },
  {
    mode: 'behavioural',
    tab: STUDY_TABS.behavioural!,
    title: 'Behavioural interviews',
    intro: 'What a behavioural round is actually scoring, how to prepare the stories it runs on, and how to tell them so they survive the follow-up. Tick a card once you have a real story ready for it.',
    labels: {
      does: 'How it works', reachWhen: 'When it comes up', tradeoffs: 'Where it goes wrong',
      numbers: 'Rules of thumb', say: 'Say it', check: 'Check yourself',
    },
    groups: BEHAVIOURAL_GROUPS,
    start: 'Set up a behavioural round',
  },
];

export const guideFor = (mode: string): StudyGuide | undefined => STUDY_GUIDES.find((g) => g.mode === mode);

export const conceptsOf = (guide: StudyGuide): Concept[] => guide.groups.flatMap((g) => g.concepts);

export const ALL_CONCEPTS: Concept[] = STUDY_GUIDES.flatMap(conceptsOf);
