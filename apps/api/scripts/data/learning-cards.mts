/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE LEARNING FEED'S BANK — THE ONLY COPY
 * ─────────────────────────────────────────────────────────────────────────────
 *  Committed in-repo like `conversational-banks.mts`, and for the same reason:
 *  nothing upstream serves this, and `question-bank.seed.json` is a SNAPSHOT
 *  that `export-seed` overwrites, so a hand-written card put there would be
 *  destroyed on the next ingest. Edit this file and re-seed.
 *
 *  Rules the CONTENT has to keep obeying — the first one inverts the rule that
 *  governs every other bank in this repo, so read it twice:
 *
 *  1. **These are READ, never spoken.** The interview banks forbid markdown,
 *     lists and code because an interviewer reads their prompts aloud. Nothing
 *     here is ever spoken. The reader is on a phone, with a thumb, deciding in
 *     two seconds whether to keep scrolling — so bodies are short, blank lines
 *     separate paragraphs, and a code block is often the clearest sentence
 *     available. Do not "fix" this to match the other banks.
 *
 *  2. **A card is one screen.** If it does not fit without scrolling on a
 *     phone it is two cards, and two cards is almost always the better answer.
 *     `learningCardSchema` caps the body at 1100 characters to hold this.
 *
 *  3. **No answer keys from the interview banks.** Never paste a concept
 *     question's `expectedPoints` or a behavioural question's `strongAnswer`
 *     in here. Those are the evaluator's half and they are what makes a round
 *     worth running; a card that reveals one spends the question for nothing.
 *     Teach the same idea in your own words instead — which is what every
 *     concepts card below does.
 *
 *  4. **Ids are stable.** They are the spaced-repetition key. Renaming a card
 *     forgets everything the reader has done with it.
 *
 *  5. **Tags are the personalisation**, and there are exactly three vocabularies
 *     that can ever match. They are compared case-insensitively against the
 *     topics of questions your own rounds failed and the delivery dimensions
 *     you score lowest on, which means a matchable tag is one of:
 *
 *       a LeetCode topic, verbatim, from `dsa_questions.topics` — "Dynamic
 *       Programming", "Union-Find", "Graph Theory". Not "dp", not "Graph".
 *
 *       a concept topic id from `conversational-banks.mts` — "nodejs",
 *       "react", "databases", "api-design".
 *
 *       a delivery dimension id from `DELIVERY_DIMENSIONS` — "structure",
 *       "concision", "humility", "followUpHandling".
 *
 *     Every card must carry at least ONE of those, or nothing can ever pull it
 *     forward. Extra descriptive tags are fine and are lowercase by convention,
 *     which is what lets `verify:feed` tell a mistyped LeetCode topic from a
 *     deliberate label: a tag STARTING with a capital must be a real topic.
 *
 *     System design is the exception with no vocabulary of its own — a design
 *     problem carries a level and no topics anywhere in the schema — so those
 *     cards are reached by the bank's order rather than by a boost.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type LearningCardSeed = {
  id: string;
  kind: 'lesson' | 'pattern' | 'quiz';
  track:
    | 'dsa'
    | 'system_design'
    | 'concepts'
    | 'jd'
    | 'experience'
    | 'behavioural'
    | 'hr'
    | 'general';
  title: string;
  body: string;
  takeaway: string;
  code?: string;
  codeLanguage?: string;
  tags?: string[];
  difficulty?: 'easy' | 'medium' | 'hard';
  choices?: string[];
  answerIdx?: number;
  explanation?: string;
};

export const LEARNING_CARDS: LearningCardSeed[] = [
  /* ══ DSA — recognition patterns ═════════════════════════════════════════════
     Every one is written as cue first, move second. That order is the whole
     point: in a round you do not get handed the pattern name, you get handed a
     sentence, and the gap between reading the sentence and knowing which
     structure to reach for is what separates a 40-minute solve from a
     10-minute one. */

  {
    id: 'two-pointers-sorted-pair',
    kind: 'pattern',
    track: 'dsa',
    title: 'Sorted array, find a pair',
    tags: ['Two Pointers', 'Array', 'Sorting', 'Binary Search'],
    difficulty: 'easy',
    body: `You see: a SORTED array, and you need two elements that add to a target — or the closest pair, or the pair with the largest area.

Reach for: one pointer at each end, moving inward. Sum too small, move left up. Too big, move right down.

Why it works: sortedness means moving left can only increase the sum and moving right can only decrease it. Every step eliminates a whole row of the n-by-n pair grid, so you never look at a pair twice.

If it is NOT sorted, this is a hash map problem instead, not a sorting problem — sorting costs n log n to save you the hash map's O(n) space, which is rarely the trade you want.`,
    takeaway: 'Sorted plus "find a pair" means two pointers. Unsorted plus "find a pair" means a hash map.',
    codeLanguage: 'python',
    code: `def two_sum_sorted(a, target):
    i, j = 0, len(a) - 1
    while i < j:
        s = a[i] + a[j]
        if s == target: return (i, j)
        if s < target: i += 1
        else: j -= 1
    return None`,
  },

  {
    id: 'sliding-window-variable',
    kind: 'pattern',
    track: 'dsa',
    title: 'Longest window that stays valid',
    tags: ['Sliding Window', 'Hash Table', 'String', 'Two Pointers'],
    difficulty: 'medium',
    body: `You see: longest / shortest CONTIGUOUS run satisfying some property — no repeated characters, at most k distinct, sum below a bound.

Reach for: a window that grows on the right and only shrinks on the left when it becomes invalid.

The shape is always the same, and getting it wrong is almost always the same mistake: shrinking with an "if" instead of a "while". One removal is not always enough to restore validity.

Cost: each index enters the window once and leaves once, so it is O(n) despite the nested loop. Say that out loud — interviewers hear a while inside a for and expect quadratic.`,
    takeaway: 'Grow right always, shrink left with a while, never an if. Each index enters and leaves once.',
    codeLanguage: 'python',
    code: `def longest_unique(s):
    seen, left, best = {}, 0, 0
    for right, ch in enumerate(s):
        if ch in seen and seen[ch] >= left:
            left = seen[ch] + 1
        seen[ch] = right
        best = max(best, right - left + 1)
    return best`,
  },

  {
    id: 'sliding-window-fixed',
    kind: 'pattern',
    track: 'dsa',
    title: 'Every window of size k',
    tags: ['Sliding Window', 'Array', 'Heap (Priority Queue)', 'Queue'],
    difficulty: 'medium',
    body: `You see: a statistic over every window of a FIXED size k — max, average, anagram match.

Reach for: compute the first window, then for each step add the entering element and remove the leaving one. Never recompute the window.

For sums that is arithmetic. For a MAXIMUM it is a monotonic deque: keep indices whose values are decreasing, pop from the back anything the newcomer beats, pop from the front anything that has left the window. The front is always the answer.

A heap also works and is easier to say, but removing the element that left costs O(n) unless you lazy-delete. Mention the deque and you have said the thing the interviewer was waiting for.`,
    takeaway: 'Fixed window: add one, remove one. For a rolling max, a monotonic deque beats a heap.',
    codeLanguage: 'python',
    code: `from collections import deque

def max_window(a, k):
    dq, out = deque(), []
    for i, x in enumerate(a):
        while dq and a[dq[-1]] <= x: dq.pop()
        dq.append(i)
        if dq[0] <= i - k: dq.popleft()
        if i >= k - 1: out.append(a[dq[0]])
    return out`,
  },

  {
    id: 'fast-slow-cycle',
    kind: 'pattern',
    track: 'dsa',
    title: 'Cycles and middles in one pass',
    tags: ['Linked List', 'Two Pointers', 'Math'],
    difficulty: 'medium',
    body: `You see: a linked list where you need the middle, the nth-from-end, or whether there is a cycle — with O(1) space.

Reach for: two pointers at different speeds. Slow one step, fast two: when fast hits the end, slow is at the middle. If there is a cycle they must eventually meet, because the gap closes by one each step.

The part people forget: finding where the cycle STARTS. Reset one pointer to the head and advance both one step at a time. They meet at the entrance. That falls out of the algebra — the distance from head to entrance equals the distance from the meeting point to the entrance, going forward.

Same trick, different name: it is also how you detect a repeated value in an array read as a function from index to value.`,
    takeaway: 'Slow-fast finds the middle and detects a cycle. Reset one to the head to find where the cycle begins.',
    codeLanguage: 'python',
    code: `def cycle_start(head):
    slow = fast = head
    while fast and fast.next:
        slow, fast = slow.next, fast.next.next
        if slow is fast:
            slow = head
            while slow is not fast:
                slow, fast = slow.next, fast.next
            return slow
    return None`,
  },

  {
    id: 'binary-search-on-answer',
    kind: 'pattern',
    track: 'dsa',
    title: 'Binary search the answer, not the array',
    tags: ['Binary Search', 'Array', 'Greedy'],
    difficulty: 'medium',
    body: `You see: "minimum capacity", "smallest speed", "least time such that everything fits". Nothing is sorted and there is nothing obvious to search.

Reach for: binary search over the ANSWER's range. You need one thing — a monotone predicate. If capacity 10 works, so does 11. That is all it takes.

The shape: write feasible(x) as a plain simulation you can defend, then binary search the smallest x where it is true.

Cost: O(n log range). The log is over the numeric range, not the array length, which is why this stays fast even when the range is a billion.

Naming the monotonicity out loud is the whole trick — it is what turns "I guessed binary search" into "binary search is valid here, and this is why".`,
    takeaway: 'If "does x work" is monotone, binary search x. Prove the monotonicity out loud before you code.',
    codeLanguage: 'python',
    code: `def min_capacity(weights, days):
    def feasible(cap):
        d, cur = 1, 0
        for w in weights:
            if cur + w > cap: d, cur = d + 1, 0
            cur += w
        return d <= days

    lo, hi = max(weights), sum(weights)
    while lo < hi:
        mid = (lo + hi) // 2
        if feasible(mid): hi = mid
        else: lo = mid + 1
    return lo`,
  },

  {
    id: 'binary-search-boundary',
    kind: 'pattern',
    track: 'dsa',
    title: 'The binary search that never off-by-ones',
    tags: ['Binary Search', 'Array'],
    difficulty: 'easy',
    body: `Stop writing binary search as "find the target". Write it as "find the first index where a condition becomes true". Every variant — first occurrence, last occurrence, insertion point, rotated pivot — is that one template with a different condition.

Invariant: lo is always a candidate or one past the end, hi is always a candidate or the end. The loop ends when they meet, so there is no "did I check the last element" question to get wrong.

Two rules that kill the classic bugs: use lo < hi, never lo <= hi with this form; and when the condition is true set hi = mid, NOT mid - 1, because mid might be the answer.

For "last true" instead of "first true", search for the first false and step back one.`,
    takeaway: 'Search for the first index where a predicate flips. One template, every variant, no off-by-one.',
    codeLanguage: 'python',
    code: `def first_true(lo, hi, pred):
    # pred is False...False True...True over [lo, hi)
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if pred(mid): hi = mid
        else: lo = mid + 1
    return lo  # == hi, first True, or hi if none`,
  },

  {
    id: 'monotonic-stack-next-greater',
    kind: 'pattern',
    track: 'dsa',
    title: 'Next greater, and the histogram family',
    tags: ['Stack', 'Monotonic Stack', 'Array'],
    difficulty: 'medium',
    body: `You see: for each element, find the next (or previous) element that is bigger or smaller. Daily temperatures, stock spans, largest rectangle in a histogram, trapping rain water.

Reach for: a stack holding INDICES whose values are monotonic. When the newcomer breaks the order, pop — and every pop is a resolved answer.

The insight worth stating: the moment you pop element i, you know both of its boundaries. The newcomer is its right boundary, and whatever is now under it on the stack is its left. That is what turns the histogram problem from quadratic into linear.

Cost: O(n). Every index is pushed once and popped once, so the inner while does not multiply the outer loop.`,
    takeaway: 'A pop is an answer. Store indices, not values, so you can recover both boundaries at once.',
    codeLanguage: 'python',
    code: `def next_greater(a):
    out, stack = [-1] * len(a), []
    for i, x in enumerate(a):
        while stack and a[stack[-1]] < x:
            out[stack.pop()] = x
        stack.append(i)
    return out`,
  },

  {
    id: 'heap-top-k',
    kind: 'pattern',
    track: 'dsa',
    title: 'Top k without sorting everything',
    tags: ['Heap (Priority Queue)', 'Sorting', 'Array', 'Divide and Conquer'],
    difficulty: 'medium',
    body: `You see: the k largest, the k closest, the k most frequent — often on a stream where you cannot hold everything.

Reach for: a heap of size k, of the OPPOSITE kind. For the k largest keep a MIN heap: the smallest of your winners sits at the top, so one comparison decides every newcomer.

Cost: O(n log k), and O(k) space. Sorting is O(n log n) and needs the whole input in memory. When k is small and n is huge, that difference is the answer they want.

If k is close to n, just sort — say so, it shows you know the bound is not free. If you need the kth element exactly once and have the whole array, quickselect is O(n) average.`,
    takeaway: 'k largest means a min heap of size k. State O(n log k) versus sorting at O(n log n).',
    codeLanguage: 'python',
    code: `import heapq

def top_k(nums, k):
    h = []
    for x in nums:
        heapq.heappush(h, x)          # two args, always
        if len(h) > k: heapq.heappop(h)
    return h`,
  },

  {
    id: 'two-heaps-median',
    kind: 'pattern',
    track: 'dsa',
    title: 'A running median needs two heaps',
    tags: ['Heap (Priority Queue)', 'Design', 'Data Stream'],
    difficulty: 'hard',
    body: `You see: a median, or a percentile, maintained as numbers arrive.

Reach for: a max heap for the lower half, a min heap for the upper half. The two tops are the two middle elements, so the median is O(1) to read and O(log n) to maintain.

Two rules keep it correct: always push into one heap and move its top to the other, so the newcomer is compared against both sides; and keep the sizes within one, rebalancing after every insert.

In Python there is only a min heap, so the lower half is stored negated. Say that out loud when you write it — an interviewer watching you push negative numbers wants to know it is deliberate.`,
    takeaway: 'Median on a stream: max heap below, min heap above, sizes within one of each other.',
    codeLanguage: 'python',
    code: `import heapq

class Median:
    def __init__(self): self.lo, self.hi = [], []   # lo is negated
    def add(self, x):
        heapq.heappush(self.lo, -heapq.heappushpop(self.hi, x))
        if len(self.lo) > len(self.hi) + 1:
            heapq.heappush(self.hi, -heapq.heappop(self.lo))
    def median(self):
        if len(self.lo) > len(self.hi): return -self.lo[0]
        return (-self.lo[0] + self.hi[0]) / 2`,
  },

  {
    id: 'union-find-connectivity',
    kind: 'pattern',
    track: 'dsa',
    title: 'Are these two in the same group?',
    tags: ['Union-Find', 'Graph Theory', 'Depth-First Search'],
    difficulty: 'medium',
    body: `You see: connected components, "number of islands" given as edges rather than a grid, detecting a cycle in an UNDIRECTED graph, or Kruskal's minimum spanning tree.

Reach for: union-find. Two operations — find the representative, union two sets — both effectively O(1) with path compression and union by size.

It beats DFS in exactly one situation, and it is a common one: edges arriving over time. DFS has to re-walk the graph after every new edge; union-find just absorbs it.

The cycle test in an undirected graph is one line: if both endpoints of an edge already share a root, that edge closes a cycle.`,
    takeaway: 'Edges arriving incrementally means union-find. Same root before the union means a cycle.',
    codeLanguage: 'python',
    code: `class DSU:
    def __init__(self, n): self.p, self.sz = list(range(n)), [1] * n
    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]   # path halving
            x = self.p[x]
        return x
    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra == rb: return False           # already joined: a cycle
        if self.sz[ra] < self.sz[rb]: ra, rb = rb, ra
        self.p[rb] = ra; self.sz[ra] += self.sz[rb]
        return True`,
  },

  {
    id: 'topological-sort',
    kind: 'pattern',
    track: 'dsa',
    title: 'Ordering things with prerequisites',
    tags: ['Topological Sort', 'Graph Theory', 'Breadth-First Search', 'Depth-First Search'],
    difficulty: 'medium',
    body: `You see: course schedules, build order, task dependencies, "can this be completed at all".

Reach for: Kahn's algorithm. Count incoming edges, start from everything with zero, and each time you remove a node decrement its neighbours. Anything that reaches zero joins the queue.

The cycle test is free and it is the part interviewers actually probe: if you emit fewer nodes than the graph has, the leftovers are in a cycle. Say that before they ask.

DFS with colours works too and gives reverse post-order, but it needs recursion depth you may not have and the cycle detection is fiddlier to explain under pressure. Kahn's is the one to write.`,
    takeaway: 'Kahn: in-degrees, a queue of zeroes, decrement on removal. Fewer emitted than nodes means a cycle.',
    codeLanguage: 'python',
    code: `from collections import deque

def topo(n, edges):
    g, indeg = [[] for _ in range(n)], [0] * n
    for a, b in edges:            # a must come before b
        g[a].append(b); indeg[b] += 1
    q = deque(i for i in range(n) if indeg[i] == 0)
    out = []
    while q:
        x = q.popleft(); out.append(x)
        for y in g[x]:
            indeg[y] -= 1
            if indeg[y] == 0: q.append(y)
    return out if len(out) == n else []   # [] means a cycle`,
  },

  {
    id: 'bfs-shortest-unweighted',
    kind: 'pattern',
    track: 'dsa',
    title: 'Shortest path when every step costs one',
    tags: ['Breadth-First Search', 'Graph Theory', 'Matrix', 'Queue'],
    difficulty: 'medium',
    body: `You see: fewest moves, minimum steps, shortest transformation, rotting oranges, a maze.

Reach for: BFS. Not DFS — DFS finds A path, BFS finds the SHORTEST one, and on an unweighted graph that difference is the entire question.

Two habits that prevent the usual bugs: mark a node visited when you ENQUEUE it, not when you dequeue it, or the same cell enters the queue many times; and process level by level when the answer is a distance, so the level counter is the answer.

Multi-source is the same code with every source in the initial queue — that is the whole trick for "all oranges rot simultaneously" and "distance to the nearest zero".`,
    takeaway: 'Unweighted shortest path is BFS. Mark visited on enqueue. Multi-source means seed the queue with all of them.',
    codeLanguage: 'python',
    code: `from collections import deque

def bfs_levels(starts, neighbours, goal):
    q, seen, dist = deque(starts), set(starts), 0
    while q:
        for _ in range(len(q)):          # one whole level
            node = q.popleft()
            if goal(node): return dist
            for nxt in neighbours(node):
                if nxt not in seen:
                    seen.add(nxt); q.append(nxt)
        dist += 1
    return -1`,
  },

  {
    id: 'dijkstra-weighted',
    kind: 'pattern',
    track: 'dsa',
    title: 'Shortest path when steps cost different amounts',
    tags: ['Graph Theory', 'Heap (Priority Queue)', 'Shortest Path'],
    difficulty: 'hard',
    body: `You see: weighted edges — travel time, network delay, cheapest flight with at most k stops.

Reach for: Dijkstra. A min heap keyed by distance so far. Pop the cheapest unfinished node, relax its edges, push the improvements.

The detail that separates a working implementation from a hanging one: check on POP whether this entry is stale (its distance is worse than the best you have recorded) and skip it. Lazy deletion is far easier than a decrease-key.

Know the boundaries, because this is where the follow-up goes. Negative edges break Dijkstra — that is Bellman-Ford. "At most k stops" also breaks it, because the cheapest path may use too many hops; that one is Bellman-Ford's k-round relaxation, or BFS by layer.`,
    takeaway: 'Dijkstra is a heap plus a staleness check on pop. Negative weights or a hop limit means Bellman-Ford.',
    codeLanguage: 'python',
    code: `import heapq

def dijkstra(g, src):                 # g[u] = [(v, w), ...]
    dist = {src: 0}
    pq = [(0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, float('inf')): continue    # stale
        for v, w in g[u]:
            nd = d + w
            if nd < dist.get(v, float('inf')):
                dist[v] = nd
                heapq.heappush(pq, (nd, v))
    return dist`,
  },

  {
    id: 'backtracking-template',
    kind: 'pattern',
    track: 'dsa',
    title: 'Generate all of them without duplicates',
    tags: ['Backtracking', 'Recursion', 'Array', 'String'],
    difficulty: 'medium',
    body: `You see: all permutations, all subsets, all valid parenthesisations, n-queens, word search, combination sum.

Reach for: choose, recurse, un-choose. The un-choose is the part people drop, and it is what makes it backtracking rather than an exponential memory leak.

Duplicates are the real test. Sort the input first, then inside the loop skip an element equal to its predecessor when the predecessor was not taken at this level. That one line is the difference between a correct answer and a list with the same subset four times.

Cost: state the branching honestly. Subsets are 2^n, permutations n factorial. That is not a failure to optimise — enumeration IS the problem — but an interviewer wants to hear you know which one you are paying.`,
    takeaway: 'Choose, recurse, un-choose. Sort first, then skip equal siblings, or you will emit duplicates.',
    codeLanguage: 'python',
    code: `def subsets_no_dupes(nums):
    nums.sort(); out, path = [], []
    def go(start):
        out.append(path[:])
        for i in range(start, len(nums)):
            if i > start and nums[i] == nums[i - 1]: continue
            path.append(nums[i])
            go(i + 1)
            path.pop()                     # un-choose
    go(0)
    return out`,
  },

  {
    id: 'dp-when-to-reach-for-it',
    kind: 'pattern',
    track: 'dsa',
    title: 'How to know it is dynamic programming',
    tags: ['Dynamic Programming', 'Recursion', 'Memoization'],
    difficulty: 'medium',
    body: `You see: count the ways, minimum cost, maximum value, "can it be done" — over a sequence of choices where an earlier choice changes what is available later.

The test, in order:

Can you write a brute-force recursion? If not, it is not DP yet.

Do the same arguments recur? Add memo and you are done — that is top-down DP, and it is a legitimate final answer.

Only then consider bottom-up, for the constant factor and to drop the recursion depth.

Say the STATE out loud before writing anything: "dp of i is the best answer using the first i items". If you cannot finish that sentence, the bug is in the state, not the code — and every minute spent coding before you can say it is a minute wasted.`,
    takeaway: 'Brute force, then memo, then table. If you cannot say what dp[i] means in one sentence, do not code it.',
  },

  {
    id: 'dp-1d-choose-or-skip',
    kind: 'pattern',
    track: 'dsa',
    title: 'The take-it-or-leave-it recurrence',
    tags: ['Dynamic Programming', 'Array'],
    difficulty: 'medium',
    body: `You see: a line of items where taking one forbids or changes the next — house robber, jump games, decode ways, climbing stairs, maximum subarray.

Reach for: dp[i] = best(dp[i-1] without taking i, dp[i-2] plus taking i). One decision per position, and only the last one or two positions matter.

Which means you almost never need the array. Two rolling variables do it in O(1) space, and making that swap in front of the interviewer after the table version works is one of the cheapest points in a DSA round.

Kadane's maximum-subarray is the same shape in disguise: best-ending-here is either extend or restart, and the answer is the best of those.`,
    takeaway: 'One decision per position means two rolling variables. Write the table, then collapse it out loud.',
    codeLanguage: 'python',
    code: `def rob(nums):
    take, skip = 0, 0
    for x in nums:
        take, skip = skip + x, max(skip, take)
    return max(take, skip)

def kadane(nums):
    best = cur = nums[0]
    for x in nums[1:]:
        cur = max(x, cur + x)      # restart or extend
        best = max(best, cur)
    return best`,
  },

  {
    id: 'dp-2d-two-sequences',
    kind: 'pattern',
    track: 'dsa',
    title: 'Two strings, one grid',
    tags: ['Dynamic Programming', 'String', 'Matrix'],
    difficulty: 'hard',
    body: `You see: edit distance, longest common subsequence, regular-expression matching, interleaving — anything comparing TWO sequences.

Reach for: a grid where dp[i][j] is the answer for the first i of one and the first j of the other. Characters match, take the diagonal; they do not, take the best of the three neighbours plus a cost.

Draw the small grid before coding. Filling in a three-by-three by hand catches the off-by-one in the base row, which is where this family always breaks — and it is the same minute you would otherwise spend debugging an index in silence.

Space: each row only needs the one above, so two rows is enough. Mention it; implement it only if asked.`,
    takeaway: 'Two sequences means a 2D table: match takes the diagonal, mismatch takes the best neighbour plus a cost.',
    codeLanguage: 'python',
    code: `def edit_distance(a, b):
    m, n = len(a), len(b)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1): dp[i][0] = i
    for j in range(n + 1): dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if a[i-1] == b[j-1]: dp[i][j] = dp[i-1][j-1]
            else: dp[i][j] = 1 + min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])
    return dp[m][n]`,
  },

  {
    id: 'dp-knapsack-shape',
    kind: 'pattern',
    track: 'dsa',
    title: 'Capacity problems: the loop order is the answer',
    tags: ['Dynamic Programming', 'Array', 'Backtracking'],
    difficulty: 'hard',
    body: `You see: a budget, a capacity, a target sum — partition into equal subsets, coin change, target sum, subset sum.

Reach for: dp indexed by capacity. And then get the loop order right, because it is the entire difference between two different problems:

Each item used AT MOST once — iterate capacity DOWNWARD, so an item cannot be reused within its own pass.

Each item used UNLIMITED times — iterate capacity UPWARD, which deliberately lets the pass see its own earlier writes.

Counting ARRANGEMENTS rather than combinations flips the nesting: capacity outside, items inside.

Three problems that look identical and differ only in those loops. Knowing which one you are in, and saying so, is what is actually being tested.`,
    takeaway: 'Bounded knapsack counts capacity down; unbounded counts up. Permutations put capacity in the outer loop.',
    codeLanguage: 'python',
    code: `def can_partition(nums):
    total = sum(nums)
    if total % 2: return False
    target = total // 2
    dp = [False] * (target + 1); dp[0] = True
    for x in nums:
        for c in range(target, x - 1, -1):   # downward: each once
            dp[c] = dp[c] or dp[c - x]
    return dp[target]`,
  },

  {
    id: 'prefix-sum-range-queries',
    kind: 'pattern',
    track: 'dsa',
    title: 'Subarray sums in constant time',
    tags: ['Prefix Sum', 'Array', 'Hash Table'],
    difficulty: 'medium',
    body: `You see: the sum of a range, many times. Or "how many subarrays sum to k".

Reach for: prefix sums. P[i] is the sum of everything before i, so a range sum is one subtraction.

The version that gets asked is the second one, and it is prefix sums plus a hash map: while scanning, ask how many earlier prefixes equal running - k. Each such prefix is a subarray ending here. Seed the map with {0: 1} so a prefix equal to k counts on its own.

Do NOT reach for sliding window here if the array can contain negatives — shrinking the window no longer reduces the sum monotonically, and that assumption is the single most common wrong answer to this question.`,
    takeaway: 'Counting subarrays with a given sum is prefix sums plus a hash map, seeded with {0: 1}.',
    codeLanguage: 'python',
    code: `from collections import defaultdict

def subarrays_summing_to(nums, k):
    seen = defaultdict(int); seen[0] = 1
    running = count = 0
    for x in nums:
        running += x
        count += seen[running - k]
        seen[running] += 1
    return count`,
  },

  {
    id: 'intervals-sort-first',
    kind: 'pattern',
    track: 'dsa',
    title: 'Intervals: the sort key is the decision',
    tags: ['Sorting', 'Array', 'Greedy', 'Heap (Priority Queue)'],
    difficulty: 'medium',
    body: `You see: merge overlapping meetings, insert an interval, how many rooms are needed, the fewest to remove.

Reach for: sort, then sweep. Which key you sort by IS the algorithm:

By START, to merge or to insert. Walk once, extend the current interval while the next one starts before the current ends.

By END, to keep the most non-overlapping intervals. Greedily keeping the earliest-ending one is provably optimal — it leaves the most room for everything after.

Minimum meeting rooms is a different shape again: a min heap of end times, or a plus-one minus-one sweep over sorted boundaries. The heap's size is the number of rooms.

Say which key you chose and why before coding. That sentence is the answer to the follow-up they were about to ask.`,
    takeaway: 'Merging sorts by start. Keeping the most non-overlapping sorts by end. Room counts use a heap of end times.',
    codeLanguage: 'python',
    code: `def merge(intervals):
    intervals.sort(key=lambda x: x[0])
    out = []
    for s, e in intervals:
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out`,
  },

  {
    id: 'trie-prefix-queries',
    kind: 'pattern',
    track: 'dsa',
    title: 'When the question is about prefixes',
    tags: ['Trie', 'String', 'Design', 'Hash Table'],
    difficulty: 'medium',
    body: `You see: autocomplete, "does any word start with", word search across a board, longest common prefix over many strings, wildcard matching on a dictionary.

Reach for: a trie. One node per character, children in a dict, a flag marking the end of a real word.

The reason it beats a hash set is precisely the prefix query: a set answers "is this word present" and nothing else, while a trie answers "is this a prefix of anything" in the length of the prefix, regardless of how many words you hold.

Its other use is pruning search. Walking a board with a trie lets you abandon a path the moment no word continues that way, which turns an intractable grid search into a fast one.

Cost: O(total characters) to build, O(length) per query. Space is the honest weakness — say so.`,
    takeaway: 'Prefix questions and dictionary-pruned searches are tries. A hash set cannot answer "is this a prefix".',
    codeLanguage: 'python',
    code: `class Trie:
    def __init__(self): self.kids, self.word = {}, False
    def add(self, w):
        node = self
        for ch in w:
            node = node.kids.setdefault(ch, Trie())
        node.word = True
    def walk(self, prefix):
        node = self
        for ch in prefix:
            node = node.kids.get(ch)
            if node is None: return None
        return node`,
  },

  {
    id: 'cyclic-sort-missing',
    kind: 'pattern',
    track: 'dsa',
    title: 'Numbers one to n, in the array itself',
    tags: ['Array', 'Two Pointers', 'Sorting', 'Hash Table'],
    difficulty: 'medium',
    body: `You see: an array of n numbers drawn from one to n. Find the missing one, the duplicate, all the missing ones — in O(1) extra space.

Reach for: the array as its own hash table. Each value has a home index. Either swap values home until everything is in place, or mark visitedness by negating the value at the index a number points to.

The constraint is the hint. When a problem bothers to tell you the value range equals the length, it is asking for exactly this and refusing the hash set you were about to build.

A subtler cousin: "find the duplicate without modifying the array" is the cycle-detection trick instead, reading index-to-value as a linked list.`,
    takeaway: 'Values one to n in an array of length n means the array is the hash table. The constraint is the hint.',
    codeLanguage: 'python',
    code: `def find_missing(nums):
    for i in range(len(nums)):
        while nums[i] != i + 1 and 1 <= nums[i] <= len(nums):
            j = nums[i] - 1
            if nums[j] == nums[i]: break     # duplicate
            nums[i], nums[j] = nums[j], nums[i]
    return [i + 1 for i, x in enumerate(nums) if x != i + 1]`,
  },

  {
    id: 'bit-xor-pairing',
    kind: 'pattern',
    track: 'dsa',
    title: 'XOR cancels pairs',
    tags: ['Bit Manipulation', 'Array', 'Math'],
    difficulty: 'easy',
    body: `You see: everything appears twice except one. Or: swap without a temporary, find the missing number, check a power of two.

Reach for: XOR. It is its own inverse, so a XOR a is zero, and order does not matter. XOR the whole array and the pairs annihilate, leaving the loner.

Three more worth having ready:

x & (x - 1) clears the lowest set bit — so it is zero exactly when x is a power of two, and repeating it counts set bits.

x & -x isolates the lowest set bit, which is how you split a "two loners" problem into two one-loner problems.

Shifting is not division for negative numbers in every language. Know which one you are writing in before you claim it is.`,
    takeaway: 'XOR annihilates pairs. x & (x-1) clears the lowest set bit; x & -x isolates it.',
    codeLanguage: 'python',
    code: `def single_number(nums):
    out = 0
    for x in nums: out ^= x
    return out

def is_power_of_two(x):
    return x > 0 and x & (x - 1) == 0`,
  },

  /* ══ DSA — lessons ═════════════════════════════════════════════════════════ */

  {
    id: 'complexity-say-it-first',
    kind: 'lesson',
    track: 'dsa',
    title: 'Say the complexity before they ask',
    tags: ['reasoning', 'structure', 'Dynamic Programming'],
    difficulty: 'easy',
    body: `Three sentences, every time, before you write a line:

"This is O of n log n time and O of n space."
"The n log n is the sort; everything after it is one pass."
"I think the lower bound here is n log n because of the comparison sort — if we could bucket the values, linear."

That is the whole performance conversation, held on your terms, in fifteen seconds. Volunteered it reads as fluency. Extracted by a follow-up it reads as something you had to be reminded to think about, and the score for reasoning is written from exactly that difference.

The second sentence is the one people skip, and it is the one that proves you did not memorise a number.`,
    takeaway: 'State time, space, and which part of the code costs it — before writing, unprompted.',
  },

  {
    id: 'amortized-vs-worst-case',
    kind: 'lesson',
    track: 'dsa',
    title: 'Amortised is not average, and interviewers check',
    tags: ['Array', 'Hash Table', 'reasoning'],
    difficulty: 'medium',
    body: `Appending to a dynamic array is O(1) AMORTISED: most appends are constant, and the occasional doubling copy is paid for by the cheap ones before it. Over n appends the total is O(n), guaranteed — not on average, not usually. Guaranteed.

Average case is a different claim entirely. A hash map lookup is O(1) on average, under an assumption about the hash function, and its worst case is O(n) when everything collides. That worst case is real: it is how hash-collision denial-of-service attacks work, and it is why languages randomise their seeds.

So: array append is amortised. Hash lookup is average. Saying "amortised" about a hash map is the tell that you learnt the word rather than the idea.`,
    takeaway: 'Amortised means the total is bounded. Average means it is usually fine. A hash map is the second.',
  },

  {
    id: 'edge-cases-checklist',
    kind: 'lesson',
    track: 'dsa',
    title: 'The seven edge cases, in order',
    tags: ['structure', 'clarity'],
    difficulty: 'easy',
    body: `Run this list out loud before you say you are done. It takes forty seconds and it is where "correct" is actually decided.

Empty input. Null or None, if the language has it.
One element.
Two elements — where most two-pointer and mid-point bugs live.
All elements equal, or all duplicates.
Already sorted, and sorted backwards.
Negative numbers, and zero. Especially zero.
Overflow, or the largest input the constraints allow.

Then trace your code on ONE of them, by hand, out loud. Not the easy one. The interviewer is not scoring whether you find a bug; they are scoring whether you would have shipped without looking.`,
    takeaway: 'Empty, one, two, duplicates, sorted, negatives and zero, overflow. Then trace one by hand out loud.',
  },

  {
    id: 'brute-force-first-out-loud',
    kind: 'lesson',
    track: 'dsa',
    title: 'Say the brute force. Do not code it.',
    tags: ['decisiveness', 'structure', 'reasoning'],
    difficulty: 'easy',
    body: `Ten seconds of "the obvious answer is to check every pair, which is O of n squared — let me see if I can do better" buys you three things at once.

It puts a correct answer on the table, so silence after it is thinking rather than failing.

It names the number you are trying to beat, which makes every later idea legible as progress.

It gives the interviewer a place to help you from. They cannot hint toward an optimisation when they do not know what you are optimising.

What it must NOT become is fifteen minutes of writing the quadratic solution. Say it, bound it, then go looking. The failure mode people actually hit is not skipping the brute force — it is implementing it and running out of clock.`,
    takeaway: 'Name the brute force and its bound in one sentence, then go looking for better. Never code it first.',
  },

  {
    id: 'hash-map-real-costs',
    kind: 'lesson',
    track: 'dsa',
    title: 'What a hash map actually costs',
    tags: ['Hash Table', 'reasoning'],
    difficulty: 'medium',
    body: `"Use a hash map" is the right answer often enough that it stops being an argument. Have the trade-offs ready for when it is challenged:

Space is O(n) and the constant is not small — a Python dict entry is tens of bytes, not four.

Ordering is gone. If the follow-up is "now return them in sorted order", you have handed back the n log n you were saving.

Keys must be hashable and immutable. Lists and slices cannot be keys; tuples can.

The lookup is average O(1), worst case O(n).

And the one interviewers actually push on: if the key space is small and dense — lowercase letters, values one to n — an ARRAY is a faster hash map with a perfect hash function. Reaching for a dict when a 26-element array would do is a real, if mild, miss.`,
    takeaway: 'Hash maps cost real space and all ordering. Small dense key spaces want an array instead.',
  },

  {
    id: 'recursion-depth-limits',
    kind: 'lesson',
    track: 'dsa',
    title: 'Recursion has a ceiling, and it is low',
    tags: ['Recursion', 'Depth-First Search', 'Linked List'],
    difficulty: 'medium',
    body: `Python's default recursion limit is a thousand. A linked list of a hundred thousand nodes, or a path-shaped graph, blows it — and the constraints on the problem usually tell you that up front.

So when the input can be large and your solution is a deep DFS, say this: "this recurses to depth n, which will not survive a hundred thousand nodes, so I would convert it to an explicit stack." Then either do it or explain the conversion.

The mechanical version: your own stack holds the same arguments the recursive call would, and post-order work needs a visited flag pushed with the node so you know whether you are arriving or returning.

Tail-call elimination will not save you. Python does not do it. JavaScript engines mostly do not either, despite the specification.`,
    takeaway: 'Deep DFS on large input overflows. Say so, then convert to an explicit stack.',
  },

  /* ══ DSA — quizzes ═════════════════════════════════════════════════════════ */

  {
    id: 'quiz-sliding-window-shrink',
    kind: 'quiz',
    track: 'dsa',
    title: 'Longest substring with at most k distinct',
    tags: ['Sliding Window', 'Hash Table', 'String'],
    difficulty: 'medium',
    body: 'You are growing a window to the right and the count of distinct characters has just exceeded k. How do you restore the window?',
    choices: [
      'Shrink from the left with a while loop until the count is k again',
      'Shrink from the left once with an if',
      'Reset the window to start at the current index',
      'Move the right pointer back one',
    ],
    answerIdx: 0,
    explanation:
      'One removal only helps if that character had a count of one. Otherwise the distinct count is unchanged and the window is still invalid — which is why an if silently returns a too-long answer on inputs with repeats. The while is the fix, and it keeps the algorithm linear because each index still leaves the window at most once.',
    takeaway: 'Sliding windows shrink with a while, never an if.',
  },

  {
    id: 'quiz-bfs-visited-timing',
    kind: 'quiz',
    track: 'dsa',
    title: 'Where does visited go?',
    tags: ['Breadth-First Search', 'Graph Theory', 'Queue'],
    difficulty: 'easy',
    body: 'In a BFS over a dense graph, when should a node be marked visited?',
    choices: [
      'When it is dequeued, so you only mark what you processed',
      'When it is enqueued, before it is ever processed',
      'After processing all of its neighbours',
      'It does not matter for correctness',
    ],
    answerIdx: 1,
    explanation:
      'Marking on dequeue lets the same node be enqueued once per incoming edge before it is ever processed. The result is still correct, but the queue can blow up to O(E) and the runtime degrades badly on dense graphs. Marking on enqueue guarantees each node enters the queue exactly once.',
    takeaway: 'Mark visited when you enqueue, not when you dequeue.',
  },

  {
    id: 'quiz-heap-direction',
    kind: 'quiz',
    track: 'dsa',
    title: 'Which heap for the k largest?',
    tags: ['Heap (Priority Queue)', 'Sorting'],
    difficulty: 'easy',
    body: 'You are streaming a billion numbers and need the 10 largest. Which heap do you keep?',
    choices: [
      'A max heap of size 10',
      'A min heap of size 10',
      'A max heap holding everything',
      'A min heap holding everything',
    ],
    answerIdx: 1,
    explanation:
      'The min heap keeps the WEAKEST of your current winners at the top, so each new number needs one comparison against it: bigger means push and pop, smaller means discard. A max heap of size 10 puts the strongest on top, which tells you nothing about who to evict. Total cost is O(n log k) with O(k) space.',
    takeaway: 'k largest means a min heap of size k. The top is who you evict.',
  },

  {
    id: 'quiz-negatives-break-window',
    kind: 'quiz',
    track: 'dsa',
    title: 'Why the window fails here',
    tags: ['Sliding Window', 'Prefix Sum', 'Array'],
    difficulty: 'medium',
    body: 'Count the subarrays summing to k, where the array may contain negative numbers. Why is a sliding window wrong?',
    choices: [
      'It is O(n squared) rather than O(n)',
      'Shrinking the window no longer reliably decreases the sum',
      'It cannot handle an empty array',
      'It needs the array to be sorted first',
    ],
    answerIdx: 1,
    explanation:
      'The window technique rests on monotonicity: grow to increase, shrink to decrease. With negatives, removing an element can INCREASE the sum, so "too big, shrink" is no longer a valid move and the scan skips valid answers. Prefix sums plus a hash map is the right tool and has no such assumption.',
    takeaway: 'Sliding windows need monotonicity. Negatives kill it — use prefix sums.',
  },

  {
    id: 'quiz-knapsack-loop-order',
    kind: 'quiz',
    track: 'dsa',
    title: 'Coins, unlimited supply',
    tags: ['Dynamic Programming', 'Array'],
    difficulty: 'hard',
    body: 'Counting ways to make an amount, with each coin usable any number of times, over a 1D dp indexed by amount. What is the loop order?',
    choices: [
      'Coins outer, amount inner ascending',
      'Coins outer, amount inner descending',
      'Amount outer, coins inner ascending',
      'Either order gives the same answer',
    ],
    answerIdx: 0,
    explanation:
      'Ascending inner lets a pass see its own writes, which is exactly what "use this coin again" means. Descending would forbid reuse — that is the bounded knapsack. Putting AMOUNT on the outside counts ordered arrangements instead, so one-then-two and two-then-one become two different answers. Three near-identical loops, three different problems.',
    takeaway: 'Unlimited use counts amount upward, with coins on the outside.',
  },

  {
    id: 'quiz-stable-sort',
    kind: 'quiz',
    track: 'dsa',
    title: 'What stability buys you',
    tags: ['Sorting', 'Array'],
    difficulty: 'medium',
    body: 'You need records sorted by department, and within a department by the existing arrival order. What does that require?',
    choices: [
      'A stable sort on department alone',
      'Sorting by a tuple of department and index, with any sort',
      'Either of the above',
      'A comparison sort rather than a counting sort',
    ],
    answerIdx: 2,
    explanation:
      'A stable sort preserves the relative order of equal keys, so one pass on department is enough. Without stability you can recover the same result by making the tie-break explicit — sort by (department, originalIndex). Knowing both routes matters because not every language guarantees stability: Python and Java object sorts do, C++ std::sort does not.',
    takeaway: 'Stability preserves ties. Without it, sort by an explicit tuple including the original index.',
  },

  /* ══ Core concepts ═════════════════════════════════════════════════════════
     Written in our own words on purpose. Never paste a concept question's
     expectedPoints in here — see rule 3 at the top of this file. */

  {
    id: 'event-loop-microtasks',
    kind: 'lesson',
    track: 'concepts',
    title: 'Why a promise beats a timer',
    tags: ['nodejs', 'javascript', 'react'],
    difficulty: 'medium',
    body: `After the current synchronous code finishes, the runtime drains the MICROTASK queue completely — every resolved promise callback, plus anything they schedule — before it takes a single macrotask such as a setTimeout or an I/O callback.

Two consequences worth being able to say:

A promise chain that keeps resolving promises can starve timers indefinitely. The event loop is not being unfair; the microtask queue is defined to be drained to empty.

await is not "pause the thread". It returns control to the loop and resumes as a microtask, which is why code after an await runs before a setTimeout of zero registered before it.

In Node, process.nextTick is drained before even the promise microtasks — a separate queue, and one more way to starve everything else.`,
    takeaway: 'Microtasks drain to empty before any timer runs. await resumes as a microtask, not a timer.',
    codeLanguage: 'javascript',
    code: `setTimeout(() => console.log('timeout'), 0);
Promise.resolve().then(() => console.log('promise'));
console.log('sync');
// sync, promise, timeout — every time`,
  },

  {
    id: 'node-blocking-the-loop',
    kind: 'lesson',
    track: 'concepts',
    title: 'One slow function stops the whole server',
    tags: ['nodejs', 'javascript'],
    difficulty: 'medium',
    body: `Node's concurrency is one JavaScript thread plus an I/O pool. Waiting on a socket is free; computing is not. A synchronous thousand-millisecond loop does not slow one request down, it makes every concurrent request wait a thousand milliseconds, health checks included.

The usual culprits are not exotic: JSON.parse on a large payload, a synchronous crypto or compression call, a regular expression that backtracks, reading a file with the Sync variant.

The fixes, in the order you should offer them: do not do it in the request path at all; move it to a worker thread; move it to a separate process or a queue; chunk it and yield with setImmediate between chunks.

"Add more instances" is not a fix for this. It makes each instance fail the same way, more expensively.`,
    takeaway: 'Node blocks on CPU, not I/O. Heavy compute belongs on a worker thread or a queue, not in the handler.',
  },

  {
    id: 'react-keys-reconciliation',
    kind: 'lesson',
    track: 'concepts',
    title: 'Why the index is a bad key',
    tags: ['react', 'javascript'],
    difficulty: 'medium',
    body: `React matches the previous children against the next ones by key. Same key means "this is the same element, update it in place"; a different key means "destroy this one and mount a new one".

Use the array index and you have told React that position identity is stable. Delete the first item and every key shifts: React reuses element zero for what was element one, keeps its DOM node, keeps its component STATE, and keeps focus and scroll position where they were. Text updates correctly; anything stateful is now attached to the wrong row.

That is why a list with index keys shows the right names next to the wrong checkboxes.

It is safe in exactly one case: a list that is never reordered, never filtered and never has items removed from anywhere but the end.`,
    takeaway: 'Index keys tell React position is identity. Any reorder or removal then moves state to the wrong row.',
  },

  {
    id: 'react-effect-dependencies',
    kind: 'lesson',
    track: 'concepts',
    title: 'The effect that fires forever',
    tags: ['react', 'javascript'],
    difficulty: 'medium',
    body: `An effect that sets state, with a dependency array containing a value derived in the render, is an infinite loop: render creates a new object, the effect sees a changed dependency, it sets state, that renders, which creates a new object.

Dependencies are compared by reference, not by value. An object or array literal, or an inline arrow function, is a NEW reference on every render.

Three ways out, in preference order:

Derive it during render instead of storing it in state. Most "sync this state to that state" effects should not exist at all.

Move the object inside the effect, so it is not a dependency.

Memoise it with useMemo or useCallback, and only then — memoising to fix a loop you created by storing derived state is treating the symptom.`,
    takeaway: 'Effect dependencies compare by reference. If it can be derived during render, it should not be an effect.',
  },

  {
    id: 'db-btree-index',
    kind: 'lesson',
    track: 'concepts',
    title: 'What an index actually is',
    tags: ['databases', 'sql', 'postgres'],
    difficulty: 'medium',
    body: `A B-tree index is a sorted structure mapping column values to row locations, kept balanced so a lookup is a handful of page reads instead of a full scan.

What it buys: equality lookups, range scans, and free ordering for ORDER BY on the same column and direction.

What it costs, and what interviewers want to hear: every insert, update and delete must maintain every index on the table. Indexes are not free reads, they are a write tax — which is why a table with twelve indexes ingests slowly.

And the part people miss: the planner may refuse your index. If the query returns a large fraction of the table, a sequential scan is genuinely cheaper than random-access page fetches through the index. An index that is never chosen is pure cost.`,
    takeaway: 'Indexes speed reads and tax every write. On low-selectivity queries the planner will ignore them anyway.',
  },

  {
    id: 'db-composite-index-order',
    kind: 'lesson',
    track: 'concepts',
    title: 'Composite indexes read left to right',
    tags: ['databases', 'sql', 'postgres'],
    difficulty: 'hard',
    body: `An index on (a, b, c) is sorted by a, then within equal a by b, then by c. That single fact answers every question about it.

It serves a query filtering on a. On a and b. On a, b and c. It serves a range on the LAST column you constrained.

It does not serve a query filtering only on b, or only on c — those are not a prefix, and there is no sorted order to search.

The practical rule: equality columns first, the range column last. A query with a = 1 AND t > x wants the index on (a, t), not (t, a), because everything after a range column is unordered within it.

So one index on (a, b) usually makes a separate index on a redundant. The reverse is never true.`,
    takeaway: 'A composite index only serves a leftmost prefix. Equality columns first, the range column last.',
  },

  {
    id: 'db-n-plus-one',
    kind: 'lesson',
    track: 'concepts',
    title: 'The N+1 query, and why it passes review',
    tags: ['databases', 'sql', 'nodejs'],
    difficulty: 'easy',
    body: `Fetch fifty posts, then loop and fetch each author. That is fifty-one queries where two would do, and it is invisible in code review because the loop looks like ordinary application logic — the queries are hidden behind an ORM property access.

It is also invisible in testing, because with three rows in the fixture it is fast.

The fix is always one of two shapes: a join, or a second query with an IN clause over the collected ids, then stitched in memory. GraphQL calls the second one a dataloader; it is the same idea.

How you FIND it is the better half of the answer: log the query count per request, and alert when it scales with the response size. A number that grows with the page is the signature, and it is the only reliable way to catch the next one.`,
    takeaway: 'N+1 hides behind ORM attribute access. Fix with a join or a batched IN — and log queries per request.',
  },

  {
    id: 'db-isolation-levels',
    kind: 'lesson',
    track: 'concepts',
    title: 'Isolation levels, by the anomaly each one stops',
    tags: ['databases', 'sql', 'postgres', 'distributed-systems'],
    difficulty: 'hard',
    body: `Do not memorise the ladder. Memorise what each rung forbids.

READ COMMITTED: you never see another transaction's uncommitted writes. You CAN see different data for the same query twice, because someone committed in between. This is the default in Postgres.

REPEATABLE READ: the same query returns the same rows all transaction long. In Postgres this is a snapshot taken at the first statement.

SERIALIZABLE: the outcome matches SOME serial order of the transactions. It is the only level that stops write skew — two transactions each reading a shared invariant, each deciding their write is safe, and together breaking it. The classic case is both doctors going off-call at once.

Higher levels cost: more conflicts, more retries. Serializable transactions must be retried by the application when they abort.`,
    takeaway: 'Pick the level by the anomaly you must forbid. Only serializable stops write skew, and it needs retry logic.',
  },

  {
    id: 'optimistic-vs-pessimistic-locking',
    kind: 'lesson',
    track: 'concepts',
    title: 'Two ways to stop a lost update',
    tags: ['databases', 'distributed-systems', 'sql'],
    difficulty: 'medium',
    body: `Two users load the same record and both save. One person's edit vanishes silently. The two defences:

PESSIMISTIC: take the lock while you read — SELECT FOR UPDATE — and hold it until commit. Correct, simple, and it serialises everyone behind the lock. Fine for a short transaction, fatal if a human is thinking while it is held.

OPTIMISTIC: read a version number with the row, and write with WHERE version = the one you read, bumping it. Zero rows updated means someone else got there first, and you retry or surface a conflict. No locks, no waiting — but you must handle the retry, and the user may lose work if you resolve it badly.

Choose by contention. Rare conflicts want optimistic. A hot row that everybody updates wants pessimistic, or a queue in front of it.`,
    takeaway: 'Optimistic locking is a version column plus a retry. Pessimistic is a held lock. Choose by contention.',
  },

  {
    id: 'idempotency-keys',
    kind: 'lesson',
    track: 'concepts',
    title: 'The retry that charged the card twice',
    tags: ['distributed-systems', 'api-design', 'nodejs'],
    difficulty: 'medium',
    body: `A client times out and retries. The first request had already succeeded — the response was what got lost. Now there are two payments.

You cannot fix this by retrying more carefully, because the client genuinely cannot tell "never arrived" from "arrived, replied, reply lost". The receiver has to make the operation safe to repeat.

The standard mechanism: the client generates an idempotency key per logical operation and sends it on every attempt. The server stores the key with the RESULT, inside the same transaction as the effect. A repeat with a known key returns the stored result instead of acting again.

Two details that decide whether it works: the key must be stored atomically with the effect, not after it; and the key must be the client's, generated once before the first attempt, not per HTTP request.`,
    takeaway: 'Idempotency keys are stored with the result, in the same transaction, and generated once by the client.',
  },

  {
    id: 'http-caching-headers',
    kind: 'lesson',
    track: 'concepts',
    title: 'Cache-Control and ETag, in one screen',
    tags: ['networking', 'api-design', 'react'],
    difficulty: 'medium',
    body: `Two mechanisms that are often confused:

FRESHNESS avoids the request entirely. Cache-Control: max-age=3600 means "do not even ask for an hour". immutable means "never revalidate, this URL's content cannot change" — which is why bundlers put content hashes in filenames.

VALIDATION makes the request cheap when freshness has expired. The server sends an ETag; the client sends If-None-Match; the server answers 304 with no body.

Where it bites: max-age on an HTML document you later need to change is unfixable — you cannot reach into the caches you told to hold it. So hash your assets and cache them for ever, and keep the document itself short-lived or no-cache.

no-cache does not mean "do not store". It means "store, but revalidate before reuse". no-store is the one that means do not keep it.`,
    takeaway: 'Freshness skips the request; ETags make it cheap. no-cache stores and revalidates — no-store does not store.',
  },

  {
    id: 'jwt-vs-session',
    kind: 'lesson',
    track: 'concepts',
    title: 'JWTs cannot be revoked. Plan around it.',
    tags: ['security', 'api-design', 'distributed-systems'],
    difficulty: 'medium',
    body: `A session cookie is a pointer: the server holds the state, so logout, permission changes and bans take effect on the next request. The cost is a lookup per request, and shared session storage.

A JWT is the state, signed. No lookup — and no revocation. A token you issued for an hour is valid for an hour, whatever you do to the account. That is not a bug in your implementation, it is the shape of the thing.

So the real designs are hybrids: short-lived access tokens (minutes) plus a long-lived refresh token that IS checked against storage and can be revoked. You have accepted a small window of staleness in exchange for not hitting the database on every request.

And if you find yourself building a denylist of live JWTs, you have rebuilt sessions with extra steps. Say that out loud — it is the point of the question.`,
    takeaway: 'JWTs trade revocation for statelessness. Short access tokens plus a revocable refresh token is the usual answer.',
  },

  {
    id: 'cors-preflight',
    kind: 'lesson',
    track: 'concepts',
    title: 'CORS is the browser, not your server',
    tags: ['networking', 'security', 'react'],
    difficulty: 'easy',
    body: `Your server answered fine. The browser refused to hand the response to your JavaScript because the response did not say the origin was allowed. CORS is enforced entirely in the browser — curl has never cared, and neither has a server-to-server call.

A PREFLIGHT is an OPTIONS request the browser sends FIRST, when the real request is not "simple" — anything with a custom header, or a content type other than form data and plain text. Your server must answer it, with the allowed origin, methods and headers, before the real request is sent at all.

The credentials trap: with credentials included, the wildcard origin is rejected. You must echo the exact origin and set Allow-Credentials true. And it is a cookie — SameSite still applies on top.

"It works in Postman" is CORS. Always.`,
    takeaway: 'CORS is browser-enforced. Preflight is a real OPTIONS request, and credentials forbid the wildcard origin.',
  },

  {
    id: 'threads-vs-async',
    kind: 'lesson',
    track: 'concepts',
    title: 'Concurrency is not parallelism',
    tags: ['nodejs', 'python', 'java', 'distributed-systems'],
    difficulty: 'medium',
    body: `Concurrency is dealing with many things at once. Parallelism is doing many things at once. A single-threaded event loop is enormously concurrent and not parallel at all.

Which you need follows from the workload:

I/O-BOUND — waiting on sockets, disks, other services. Async or an event loop wins: ten thousand waiting connections cost ten thousand small state machines, not ten thousand stacks.

CPU-BOUND — hashing, parsing, image work. You need real parallelism: threads in a runtime that allows it, or processes.

This is the whole substance of "why does Python use multiprocessing". The global interpreter lock permits one thread of bytecode at a time, so threads help with waiting and never with computing — and the same distinction, in different clothing, is why Node has worker threads.`,
    takeaway: 'I/O-bound wants async; CPU-bound wants processes or real threads. Concurrency is not parallelism.',
  },

  {
    id: 'gc-generational',
    kind: 'lesson',
    track: 'concepts',
    title: 'Why garbage collectors bet on youth',
    tags: ['java', 'javascript', 'nodejs'],
    difficulty: 'hard',
    body: `The generational hypothesis: most objects die very young. Almost every production collector is built on it.

So the heap is split. New objects go in a small nursery, collected often and quickly — a scavenge copies out the few survivors and declares the rest of the region free without touching it, so cost is proportional to what LIVED, not to what died. Survive enough scavenges and you are promoted to the old generation, which is collected rarely and expensively.

What this means for your code: short-lived allocation is nearly free, and the expensive pattern is the medium-lived object — a cache entry that survives the nursery, gets promoted, and then dies, forcing the collector to do the slow kind of work.

A memory LEAK in a managed language is not a failure to free. It is a reference you forgot you were holding: a listener never removed, an unbounded cache, a closure over a large object.`,
    takeaway: 'Young objects are cheap to collect. Leaks are references you forgot — listeners, caches, closures.',
  },

  {
    id: 'quiz-microtask-order',
    kind: 'quiz',
    track: 'concepts',
    title: 'What prints first?',
    tags: ['nodejs', 'javascript', 'react'],
    difficulty: 'medium',
    body: 'A handler calls setTimeout(f, 0), then queueMicrotask(g), then returns. Which runs first, and why?',
    choices: [
      'f, because zero milliseconds has already elapsed',
      'g, because the microtask queue drains before any macrotask',
      'Whichever was registered first — the queues are shared',
      'It is not specified and varies by engine',
    ],
    answerIdx: 1,
    explanation:
      'Microtasks and macrotasks are separate queues with a fixed precedence: after the current task, the engine drains microtasks to EMPTY before taking the next macrotask. A timer of zero is still a macrotask, so it always loses. This is also why an endless chain of promises can starve timers entirely.',
    takeaway: 'Microtasks always beat timers, whatever the delay.',
  },

  {
    id: 'quiz-index-prefix',
    kind: 'quiz',
    track: 'concepts',
    title: 'Which query uses the index?',
    tags: ['databases', 'sql', 'postgres'],
    difficulty: 'hard',
    body: 'Given an index on (tenant_id, created_at), which query can use it for both filtering and ordering?',
    choices: [
      'WHERE created_at > $1 ORDER BY tenant_id',
      'WHERE tenant_id = $1 ORDER BY created_at',
      'WHERE created_at = $1 ORDER BY created_at',
      'All three, since both columns are indexed',
    ],
    answerIdx: 1,
    explanation:
      'The index is sorted by tenant_id first, and only within one tenant is it sorted by created_at. Fixing tenant_id with equality lands you in a contiguous run already ordered by created_at, so the sort is free. Filtering on created_at alone is not a leftmost prefix and the index cannot be scanned for it.',
    takeaway: 'Equality on the leading column makes the next column sorted for free.',
  },

  {
    id: 'quiz-jwt-logout',
    kind: 'quiz',
    track: 'concepts',
    title: 'Logging out a JWT',
    tags: ['security', 'api-design'],
    difficulty: 'medium',
    body: 'A user clicks log out. Your API authenticates with a stateless JWT valid for one hour. What actually happens to the token?',
    choices: [
      'It is invalidated server-side immediately',
      'It stays valid until it expires, unless you keep a denylist',
      'It is invalidated as soon as the client deletes it',
      'The signature check starts failing once the session ends',
    ],
    answerIdx: 1,
    explanation:
      'A stateless token carries its own validity — nothing on the server is consulted, so nothing on the server can revoke it. Deleting the client copy stops YOUR app sending it, but a copy taken beforehand still authenticates. Real revocation requires state: a denylist, or short access tokens plus a revocable refresh token.',
    takeaway: 'Nothing is checked, so nothing can be revoked. Revocation needs state.',
  },

  {
    id: 'quiz-cors-failure',
    kind: 'quiz',
    track: 'concepts',
    title: 'Works in Postman, fails in the browser',
    tags: ['networking', 'security', 'api-design'],
    difficulty: 'easy',
    body: 'A POST with a JSON content type succeeds from a terminal but fails from the page with no request appearing in your server logs. What happened?',
    choices: [
      'The server rejected the request body',
      'A CORS preflight OPTIONS request failed or was not answered',
      'The browser could not resolve the hostname',
      'The response was cached as an error',
    ],
    answerIdx: 1,
    explanation:
      'A JSON content type makes the request non-simple, so the browser sends an OPTIONS preflight first and only sends the real request if it is allowed. An unanswered preflight means the POST never leaves the browser — which is exactly why it is missing from the access log while a terminal client sails through.',
    takeaway: 'No POST in the log at all means the preflight was refused.',
  },

  /* ══ System design ═════════════════════════════════════════════════════════ */

  {
    id: 'estimation-numbers-to-know',
    kind: 'lesson',
    track: 'system_design',
    title: 'The six numbers that carry an estimate',
    tags: ['estimation', 'scalability'],
    difficulty: 'easy',
    body: `You are not being tested on arithmetic. You are being tested on whether you will design without checking the scale.

A day is about 100,000 seconds. So a million events a day is roughly 10 per second. A billion a day is about 12,000 per second.

Peak is typically 2 to 5 times average. Design for peak, say which multiple you assumed.

A kilobyte row, a million rows, is a gigabyte. Say the row size out loud and the storage answer falls out.

A commodity server handles a few thousand simple requests per second. A single Postgres instance handles tens of thousands of simple reads per second with a warm cache.

Round hard. 86,400 is 100,000. Nobody wants four significant figures; they want the exponent and the assumption underneath it.`,
    takeaway: 'A day is 100k seconds, peak is 2-5x average, round aggressively — and say every assumption out loud.',
  },

  {
    id: 'latency-numbers',
    kind: 'lesson',
    track: 'system_design',
    title: 'Latency numbers that decide designs',
    tags: ['estimation', 'scalability', 'caching'],
    difficulty: 'medium',
    body: `Memory read: well under a microsecond.
Local network round trip: about half a millisecond.
SSD random read: about a tenth of a millisecond.
Cross-continent round trip: 60 to 150 milliseconds — and that one is the speed of light, so no amount of money fixes it.

What follows from the last line is the whole point. If a user in Singapore must reach a database in Virginia, every request costs 200 milliseconds before you have done any work. That is why you replicate reads regionally, put a CDN in front of static content, and keep synchronous cross-region calls off the request path entirely.

It is also why "just add a cache" is only sometimes the answer: a cache in the wrong region saves the database and not the user.

And why chatty APIs are so expensive: ten sequential calls at 100 milliseconds is a second of nothing.`,
    takeaway: 'Cross-region round trips are physics, not engineering. Replicate reads and stop making sequential hops.',
  },

  {
    id: 'cache-aside-vs-write-through',
    kind: 'lesson',
    track: 'system_design',
    title: 'Three caching strategies and what each risks',
    tags: ['caching', 'scalability', 'databases'],
    difficulty: 'medium',
    body: `CACHE-ASIDE (lazy). The application checks the cache, misses, reads the database, and populates. Simple, resilient — a cache outage degrades to slow, not broken. Cost: every key is stale after a write unless you invalidate, and the first request after every eviction is slow.

WRITE-THROUGH. Writes go to cache and database together. Reads are always fresh. Cost: writes are slower, and you cache things nobody ever reads.

WRITE-BEHIND. Write to cache, flush to the database asynchronously. Fast writes, and you can lose data on a crash. Only with a durable buffer.

Almost every real answer is cache-aside plus a short TTL plus explicit invalidation on write. The TTL is not laziness — it is the bound on how wrong you can be when an invalidation is missed, and there will always be a missed invalidation.`,
    takeaway: 'Default to cache-aside with a TTL and explicit invalidation. The TTL bounds the damage of a missed one.',
  },

  {
    id: 'cache-stampede',
    kind: 'lesson',
    track: 'system_design',
    title: 'When the cache expires, everything asks at once',
    tags: ['caching', 'scalability', 'reliability'],
    difficulty: 'hard',
    body: `A hot key expires. Ten thousand concurrent requests all miss, all query the database, all recompute the same value. The database falls over — at the exact moment traffic is highest, because that is when the key was hot.

Three defences, usually combined:

A LOCK per key, so one request recomputes and the rest wait briefly or serve stale.

EARLY recomputation: refresh probabilistically as expiry approaches, so the value is renewed before anybody misses.

JITTERED TTLs. Ten thousand keys populated by one deployment with the same TTL will expire in the same second. Add randomness so they do not.

Same shape, different name: the thundering herd on cold start, and the retry storm after an outage. The general lesson is that synchronised clients are a load pattern you build, not one you receive.`,
    takeaway: 'Hot-key expiry is a stampede. Lock per key, refresh early, and jitter every TTL.',
  },

  {
    id: 'sharding-key-choice',
    kind: 'lesson',
    track: 'system_design',
    title: 'The shard key is the design',
    tags: ['databases', 'scalability', 'distributed-systems'],
    difficulty: 'hard',
    body: `Once data is split across machines, the key you split on decides what is cheap for ever, and it is the hardest thing to change later.

By ENTITY (user id, tenant id): everything about one user is on one shard, so their queries are single-shard and fast. Cross-entity queries — "all orders today" — now hit every shard and merge.

By TIME: recent data is co-located, which is ideal for logs. And the current shard takes every single write, which is the definition of a hotspot.

By HASH: even distribution, no hotspots, and range queries are gone.

Say the hotspot out loud whichever you pick. Celebrity users, one huge tenant, or Black Friday traffic all break an even-looking scheme, and "this shard would be hot, so I would split it further or give it dedicated capacity" is the sentence the question exists to elicit.`,
    takeaway: 'Entity keys make single-entity reads cheap and cross-entity reads expensive. Name the hotspot yourself.',
  },

  {
    id: 'consistent-hashing',
    kind: 'lesson',
    track: 'system_design',
    title: 'Why not just hash modulo the node count',
    tags: ['distributed-systems', 'caching', 'scalability'],
    difficulty: 'hard',
    body: `Because adding one node changes the modulus, so nearly every key moves. Go from nine nodes to ten and about ninety percent of your cache relocates — a cold cache and a stampede at the moment you were trying to add capacity.

Consistent hashing puts nodes and keys on a ring. A key belongs to the first node clockwise. Add a node and only the keys between it and its predecessor move: on average, one node's share.

Two refinements that always come up. VIRTUAL NODES — each physical node occupies many ring positions — because a handful of random positions distributes badly and a departing node dumps its whole range on one neighbour. And REPLICATION, by walking clockwise to the next N distinct nodes.

It is the backbone of Dynamo-style stores, Cassandra, and every large memcached deployment.`,
    takeaway:
      'Modulo rehashes everything when the node count changes. The ring moves one share, with virtual nodes to even it out.',
  },

  {
    id: 'replication-read-your-writes',
    kind: 'lesson',
    track: 'system_design',
    title: 'The user who cannot see their own comment',
    tags: ['databases', 'distributed-systems', 'scalability'],
    difficulty: 'medium',
    body: `Writes go to the primary, reads are spread over replicas, replication lags by tens or hundreds of milliseconds. The user posts a comment, the page reloads from a replica that has not caught up, and their comment is gone. They post it again.

This is not a bug to be fixed by making replication faster. It is a consistency model, and you choose one:

READ YOUR WRITES: route a user's reads to the primary for a short window after they write, or pin them to the replica that has their write.

MONOTONIC READS: pin one user to one replica for a session, so time never appears to run backwards even if they are behind.

Or accept it where it does not matter — a view count, a recommendation list, a follower total.

Naming which guarantee each screen needs, rather than making the whole system strongly consistent, is the answer being looked for.`,
    takeaway: 'Replica lag is a consistency choice. Give writers read-your-writes and let cold data lag.',
  },

  {
    id: 'queue-delivery-semantics',
    kind: 'lesson',
    track: 'system_design',
    title: 'Exactly-once does not exist. Say it plainly.',
    tags: ['distributed-systems', 'messaging', 'reliability'],
    difficulty: 'hard',
    body: `AT MOST ONCE: acknowledge before processing. Fast, and messages are lost when a consumer dies mid-work.

AT LEAST ONCE: acknowledge after processing. Nothing is lost, and a crash between the work and the acknowledgement means the message is redelivered. This is what essentially every production queue gives you.

EXACTLY ONCE, end to end and across systems, is not achievable — the acknowledgement can always be the thing that is lost. What products sell under that name is at-least-once delivery plus deduplication inside their own boundary.

So the real engineering answer is: at-least-once delivery, plus IDEMPOTENT consumers. Deduplicate on a message id, or make the operation naturally repeatable — set a status rather than incrementing a counter.

And have an answer for the poison message: a retry limit and a dead-letter queue, or one bad message blocks the partition for ever.`,
    takeaway: 'Take at-least-once and make the consumer idempotent. Always have a retry limit and a dead-letter queue.',
  },

  {
    id: 'rate-limiter-designs',
    kind: 'lesson',
    track: 'system_design',
    title: 'Four rate limiters, and the one to pick',
    tags: ['scalability', 'api-design', 'distributed-systems'],
    difficulty: 'medium',
    body: `FIXED WINDOW: a counter per key per minute. Trivial, and it permits a double burst across the boundary — a full quota at 11:59:59 and another at 12:00:00.

SLIDING WINDOW LOG: timestamps per key, count what is inside the window. Exact, and it stores every request.

SLIDING WINDOW COUNTER: weight the previous window by how much of it remains. Nearly exact, one number per window. The usual production compromise.

TOKEN BUCKET: tokens refill at a steady rate, each request spends one, the bucket has a cap. It is the only one that deliberately ALLOWS a burst up to the bucket size, which is usually what you actually want — users are bursty, and a strict limiter feels broken.

Distributed, this lives in Redis, and the check-and-decrement must be atomic — a Lua script or an incr with an expiry, never a get followed by a set.`,
    takeaway: 'Token bucket for user-facing APIs. Distributed counters must be atomic, never get-then-set.',
  },

  {
    id: 'feed-fanout',
    kind: 'lesson',
    track: 'system_design',
    title: 'Fan-out on write, or on read',
    tags: ['scalability', 'caching', 'databases'],
    difficulty: 'hard',
    body: `Building a timeline, there are two shapes and one right answer.

FAN-OUT ON WRITE: when I post, push the id into every follower's precomputed timeline. Reads are one lookup — perfect, because reads outnumber writes hugely. It fails on celebrities: one post by an account with fifty million followers is fifty million writes.

FAN-OUT ON READ: store posts once, and at read time gather from everyone you follow and merge. Cheap writes, expensive reads, and the read cost scales with how many people you follow.

The production answer is HYBRID. Fan out on write for ordinary accounts; for a small set of very-high-follower accounts, fetch at read time and merge into the precomputed timeline.

That hybrid is the expected answer, and saying WHY — the follower distribution has a long tail — is what distinguishes it from a memorised one.`,
    takeaway: 'Fan out on write, except for celebrities, who are merged in at read time. The follower tail forces the hybrid.',
  },

  {
    id: 'outbox-pattern',
    kind: 'lesson',
    track: 'system_design',
    title: 'You cannot commit a database and a queue together',
    tags: ['distributed-systems', 'messaging', 'databases', 'reliability'],
    difficulty: 'hard',
    body: `Save the order, then publish the event. If the publish fails, the order exists and nothing downstream knows. Publish first and the order might not save. There is no ordering of two separate systems that is safe — this is the dual-write problem, and two-phase commit is not a real option across a database and a broker.

The TRANSACTIONAL OUTBOX: inside the same database transaction that saves the order, insert a row into an outbox table. Atomic, because it is one transaction in one database. A separate process then reads unpublished outbox rows and publishes them, marking them sent.

The publisher can crash after publishing and before marking — so events are at-least-once, and consumers must be idempotent. Again.

Change-data-capture, reading the database's own replication log, is the same idea with the polling loop provided for you.`,
    takeaway: 'Write the event to an outbox table in the same transaction, and publish it from there. Never dual-write.',
  },

  {
    id: 'circuit-breaker-and-backoff',
    kind: 'lesson',
    track: 'system_design',
    title: 'Retries are how outages spread',
    tags: ['reliability', 'distributed-systems', 'scalability'],
    difficulty: 'medium',
    body: `A dependency slows down. Every caller retries. The dependency now receives three times the traffic while already struggling, and the callers pile up threads waiting on it. The outage propagates upward, and it was your retry policy that spread it.

Four controls, and you should name all four:

EXPONENTIAL BACKOFF WITH JITTER. Without jitter, every client retries in the same instant for ever.

A RETRY BUDGET. Cap retries as a fraction of traffic, not per request.

A CIRCUIT BREAKER. After a threshold of failures, fail fast for a cooldown, then let a trial request through. This is what stops the pile-up.

TIMEOUTS, everywhere, shorter as you go deeper. A request with no timeout is a thread you have given away permanently.

And retry only what is safe to retry, which puts you back at idempotency.`,
    takeaway: 'Backoff with jitter, a retry budget, a circuit breaker, and timeouts at every hop. Retries amplify outages.',
  },

  {
    id: 'golden-signals',
    kind: 'lesson',
    track: 'system_design',
    title: 'What you would put on the dashboard',
    tags: ['reliability', 'observability', 'scalability'],
    difficulty: 'medium',
    body: `Every design question ends with "how would you know it was working". Have four signals ready:

LATENCY — and at percentiles, never the mean. The mean hides everything: with a hundred-millisecond mean, the ninety-ninth percentile can be four seconds and that is the experience a meaningful slice of users actually has.

TRAFFIC — requests per second, by endpoint.

ERRORS — rate, split by cause. A 400 spike is a client release; a 500 spike is you.

SATURATION — how full the constrained resource is. Queue depth, connection pool usage, disk. This is the one that predicts the outage instead of reporting it.

Then say what you would ALERT on: symptoms users feel, not causes. Alert on the error rate and the latency budget; put CPU on a dashboard. Paging on a cause wakes people for things that do not matter and misses the ones that do.`,
    takeaway: 'Latency at percentiles, traffic, errors, saturation. Alert on symptoms; dashboard the causes.',
  },

  {
    id: 'design-start-with-requirements',
    kind: 'lesson',
    track: 'system_design',
    title: 'The first five minutes decide the round',
    tags: ['structure', 'listening', 'clarity'],
    difficulty: 'easy',
    body: `Do not draw a box until you have written these down, out loud, and had them confirmed:

FUNCTIONAL: what can a user do? Three bullets, not ten. "Post, follow, read a timeline." Explicitly park the rest — "I am going to leave search and notifications out unless you want them" — so the scope is a shared decision rather than something you silently dropped.

SCALE: users, requests per second, read-to-write ratio, data size. If you are not told, propose a number and ask if it is reasonable.

NON-FUNCTIONAL: latency target, availability target, and — the one people forget — which way you lean when consistency and availability conflict, and for WHICH data.

This is the phase people rush because it does not look like designing. It is the phase that decides whether the next thirty minutes are answering the question you were asked.`,
    takeaway: 'Functional scope, scale numbers, then latency and consistency targets. Confirm all three before drawing.',
  },

  {
    id: 'quiz-fanout-celebrity',
    kind: 'quiz',
    track: 'system_design',
    title: 'Fifty million followers',
    tags: ['scalability', 'caching'],
    difficulty: 'hard',
    body: 'Your timeline is fan-out on write. An account with fifty million followers posts. What breaks first, and what is the fix?',
    choices: [
      'Reads slow down; add read replicas',
      'One post becomes fifty million writes; merge celebrity posts at read time',
      'The cache expires; lengthen the TTL',
      'Nothing — fan-out on write handles any follower count',
    ],
    answerIdx: 1,
    explanation:
      'Fan-out on write trades write amplification for cheap reads, and the amplification factor is the follower count. For the long tail of ordinary accounts that is a fine trade; for the handful with tens of millions of followers it is a write storm per post. The standard fix is hybrid: precompute for ordinary accounts, and fetch the small number of celebrity posts at read time and merge.',
    takeaway: 'Write amplification equals follower count. Celebrities get merged at read time.',
  },

  {
    id: 'quiz-exactly-once',
    kind: 'quiz',
    track: 'system_design',
    title: 'The queue promises exactly-once',
    tags: ['distributed-systems', 'messaging', 'reliability'],
    difficulty: 'medium',
    body: 'A consumer processes a message, then crashes before acknowledging. What is the correct design response?',
    choices: [
      'Acknowledge before processing so it cannot repeat',
      'Make the consumer idempotent and accept redelivery',
      'Use a broker that guarantees exactly-once delivery',
      'Wrap the processing and the acknowledgement in a transaction',
    ],
    answerIdx: 1,
    explanation:
      'Acknowledging first converts redelivery into data loss. No broker can offer end-to-end exactly-once across systems, because the acknowledgement itself can be lost. And the work and the acknowledgement live in different systems, so no single transaction spans them. At-least-once plus an idempotent consumer is the design that actually survives.',
    takeaway: 'At-least-once plus idempotent consumers. Exactly-once is a marketing boundary, not a guarantee.',
  },

  {
    id: 'quiz-p99-vs-mean',
    kind: 'quiz',
    track: 'system_design',
    title: 'The mean looks fine',
    tags: ['reliability', 'observability', 'estimation'],
    difficulty: 'medium',
    body: 'Mean response time is 90ms and the p99 is 4 seconds. A page makes 10 parallel calls and waits for all of them. What fraction of page loads take over 4 seconds?',
    choices: ['About 1 percent', 'About 10 percent', 'About 0.1 percent', 'About 50 percent'],
    answerIdx: 1,
    explanation:
      'Waiting for all of them means the slowest decides. The chance that all ten avoid the tail is 0.99 to the tenth, about 0.904 — so roughly ten percent of page loads hit it. Fan-out multiplies tail latency into the common case, which is precisely why tail latency is a design constraint rather than a statistic.',
    takeaway: 'Fan-out turns the tail into the common case. Ten calls make a p99 a p90.',
  },

  /* ══ Behavioural, HR and interview craft ═══════════════════════════════════ */

  {
    id: 'star-structure',
    kind: 'lesson',
    track: 'behavioural',
    title: 'STAR, with the time actually allocated',
    tags: ['structure', 'concision'],
    difficulty: 'easy',
    body: `Two minutes, and the budget is not even:

SITUATION — 15 seconds. Where, when, what was at stake. Not the org chart.
TASK — 15 seconds. What was specifically YOURS to do.
ACTION — 60 seconds. The decisions you made and why you made them. This is the answer; everything else is framing.
RESULT — 30 seconds. What changed, with a number, and what you learned.

The universal failure is spending ninety seconds on the situation and thirty on everything else, because the setup is the part you can recall without thinking. The interviewer is scoring the action, and they are scoring the reason behind each decision, not the decision.

Rehearse the timing once, out loud, with a clock. It is the single cheapest improvement available in a behavioural round.`,
    takeaway: 'Fifteen, fifteen, sixty, thirty. The action is the answer — the setup is not the story.',
  },

  {
    id: 'star-i-not-we',
    kind: 'lesson',
    track: 'behavioural',
    title: '"We" is the word that loses the round',
    tags: ['clarity', 'confidence'],
    difficulty: 'easy',
    body: `"We identified the bottleneck, we rewrote the query layer, we shipped it in two weeks."

The interviewer cannot score any of that, because they cannot tell what you did. A team of eight did something good and you were present.

Say I for your own decisions and we only for genuinely shared work, and make the boundary explicit: "The team rewrote the service; I owned the migration plan, and I made the call to run both paths in parallel for a week rather than cut over."

That sentence is not arrogant. It is the only version that is auditable, and hedging it is not modesty — it is withholding the evidence you were asked for.

Listen for this in your own recordings. Count the we's. It is the fastest thing to fix and the most consistently scored.`,
    takeaway: 'Say "I" for your decisions and name the boundary with the team. "We" makes your contribution unscoreable.',
  },

  {
    id: 'failure-story-shape',
    kind: 'lesson',
    track: 'behavioural',
    title: 'The failure question is a trap with one exit',
    tags: ['humility', 'reasoning'],
    difficulty: 'medium',
    body: `"Tell me about a time you failed" has three wrong answers and one right one.

Wrong: a disguised strength. "I care too much about quality." Everybody has heard it, and it reads as evasion.
Wrong: a failure that was someone else's. Blaming, with extra steps.
Wrong: a catastrophe with no recovery. You have volunteered evidence against yourself.

Right: a real, bounded failure that was YOURS, where you can say what you would now do differently AND point at a later occasion where you did it.

That last clause is the whole question. They are not testing whether you fail. They are testing whether failure changes your behaviour — so the story is not complete until it contains the second event where the lesson showed up.

Pick one now. Having to improvise this one under pressure is how the disguised strength escapes.`,
    takeaway: 'A real failure, owned, plus a later moment where the lesson visibly changed what you did.',
  },

  {
    id: 'conflict-story-shape',
    kind: 'lesson',
    track: 'behavioural',
    title: 'Disagreement stories are about the method',
    tags: ['listening', 'professionalism'],
    difficulty: 'medium',
    body: `When they ask about conflict with a colleague, they are not checking whether you were right. They are checking how you behave when you believe you are right.

The shape that works: state both positions fairly — including theirs, at its strongest. Say what you did to test who was right, not to win. Say what decided it, and say what you did once it was decided.

The ending matters more than the middle, and there are two good ones. You were right, the evidence showed it, and you did not gloat. Or you were wrong, you said so, and you committed to their approach properly rather than sulking through it.

The one to avoid: escalating to a manager as the first move. Fine as a last resort, and as an opener it says you would rather be adjudicated than persuade.`,
    takeaway: 'State their position at its strongest, describe how you tested it, and commit cleanly to whatever won.',
  },

  {
    id: 'clarifying-questions-first',
    kind: 'lesson',
    track: 'general',
    title: 'Three questions before any answer',
    tags: ['listening', 'structure', 'clarity'],
    difficulty: 'easy',
    body: `Never start at the answer. Thirty seconds of questions changes how everything after it is scored.

For a coding problem: what is the input size? Can it contain duplicates, negatives, or be empty? Should I optimise for time or for space?

For a design problem: how many users, what read-to-write ratio, which way do we lean when consistency and availability conflict?

For a behavioural one: "Do you want the technical decision or the people side?" — that one is free and almost nobody asks it.

Two reasons this pays. It stops you solving a harder or easier problem than the one on the table, which is the most expensive mistake available. And it reads as the thing they are literally scoring under "requirements gathering", which is a real line on most rubrics.

Then say what you are assuming and move. Questions are not stalling.`,
    takeaway: 'Thirty seconds of scoping questions, then state your assumptions and start. It is scored explicitly.',
  },

  {
    id: 'think-aloud-protocol',
    kind: 'lesson',
    track: 'general',
    title: 'Silence is the only unrecoverable mistake',
    tags: ['fluency', 'clarity', 'confidence'],
    difficulty: 'easy',
    body: `An interviewer cannot score thinking they cannot hear. Worse, they cannot help you — they are usually willing to, and a silent candidate gives them nothing to push against.

What to narrate, in order of usefulness:

The option you are weighing and why: "A heap is the obvious move, but the k here might be close to n, so let me check whether sorting is simpler."

The dead end, as you abandon it: "That does not work, because the window can contain negatives." Abandoning an approach OUT LOUD is evidence of judgement. Abandoning it silently looks like forgetting.

The thing you need a moment for: "Give me twenty seconds to work through the indices." A declared pause is not silence.

What not to narrate: every keystroke. Read your code aloud as you type it and you have replaced reasoning with dictation.`,
    takeaway: 'Narrate options, dead ends and declared pauses. Silence cannot be scored or rescued.',
  },

  {
    id: 'when-you-dont-know',
    kind: 'lesson',
    track: 'general',
    title: 'The three-part answer to something you do not know',
    tags: ['humility', 'confidence', 'followUpHandling'],
    difficulty: 'medium',
    body: `Bluffing is the worst available outcome, and interviewers detect it immediately — the register changes, the sentences get longer, the specifics disappear.

The answer that scores well has three parts and takes twenty seconds:

Name the boundary plainly. "I have not used Kafka in production."
Give the adjacent thing you DO know. "I have worked with SQS, so I know at-least-once delivery and dead-letter queues."
Reason toward it. "So I would expect partitions to be the ordering unit, and consumer groups to be how you parallelise — is that right?"

That last question turns a gap into a conversation, and interviewers routinely fill it in and let you continue.

This is one of the twelve things scored explicitly in your own reports, under calibration: confidence tracking knowledge. Saying "I do not know" cleanly scores HIGHER than a shaky guess.`,
    takeaway: 'Name the boundary, bridge from what you do know, reason forward, then ask. Never bluff.',
  },

  {
    id: 'answer-first-then-detail',
    kind: 'lesson',
    track: 'general',
    title: 'Answer first. Then the reasoning.',
    tags: ['structure', 'concision', 'clarity'],
    difficulty: 'easy',
    body: `Asked "would you use SQL or NoSQL here", there are two orders available.

The one most people use: two minutes of considerations, trade-offs, and it depends — arriving, maybe, at an answer. By then the interviewer has stopped tracking and has written down "did not commit".

The one that scores: "Postgres. The access pattern is relational and the scale does not need sharding yet." Then, and only then, the reasoning and the conditions under which you would change your mind.

This is the single most transferable habit on this page. It works for verdicts, for estimates, for status updates and for code review. Answer, then support.

The fear behind the wrong order is that committing early looks rash. It does not. Committing with a stated reason and a named condition for changing reads as decisiveness, which is scored separately from correctness — and you can still be talked out of it.`,
    takeaway: 'Lead with the verdict in one sentence, then the reasoning and what would change your mind.',
  },

  {
    id: 'salary-do-not-name-first',
    kind: 'lesson',
    track: 'hr',
    title: 'The first number loses. Deflect twice.',
    tags: ['composure', 'confidence'],
    difficulty: 'medium',
    body: `"What are your salary expectations?" arrives in the first ten minutes, before you know what the role pays.

Deflect once, warmly: "I would rather understand the scope first. What range is budgeted for this level?"

If pressed, deflect again with a reason: "I would not want to anchor low or price myself out before we have talked about the work. You will have a band — what is it?"

If pressed a third time, give a RANGE, researched, with your target at the BOTTOM of it, and attach a condition: "Based on what I have seen for this level in this market, I am looking at X to Y, depending on the overall package."

What never to do: name your current salary. In many places they may not ask, and everywhere it is the anchor that caps the offer — your next salary should follow from the role's value, not from what your last employer happened to pay.`,
    takeaway: 'Deflect twice, then give a researched range with your target at its floor. Never volunteer your current pay.',
  },

  {
    id: 'salary-the-pause',
    kind: 'lesson',
    track: 'hr',
    title: 'When the offer lands, say almost nothing',
    tags: ['composure', 'decisiveness'],
    difficulty: 'medium',
    body: `The offer arrives. The instinct is to fill the silence — to accept, to thank them twice, to explain that it is fine.

Do not. Say: "Thank you. I am genuinely excited about this. Can I take a day to look at the whole package?"

Then negotiate on ONE thing, not five. Pick the item that matters most, ask for a specific number, and justify it with the role's value rather than your needs: "Given the scope of this position and what I have seen for it, could we get the base to X?" A list of five asks reads as shopping; one specific ask reads as a decision.

And know what else is movable, because base salary is often the most fixed part: sign-on, equity refresh, start date, title, level, remote days, a learning budget.

Silence after your ask is not a refusal. Let them speak next.`,
    takeaway: 'Take a day, ask for one specific number, justify it by the role, and then stop talking.',
  },

  {
    id: 'questions-to-ask-them',
    kind: 'lesson',
    track: 'general',
    title: 'The questions that are still being scored',
    tags: ['professionalism', 'listening'],
    difficulty: 'easy',
    body: `"Any questions for me?" is not the end of the interview. It is a final, lightly disguised sample of how you think.

Three that work anywhere, because they cannot be answered from the careers page:

"What does someone who is doing well in this role six months in actually look like?"
"What is the thing about working here that people are surprised by?"
"What is on the roadmap that you are least sure how you will build?"

That last one is the good one. The answer tells you the real technical risk, and asking it says you expect to be near it.

What to avoid: anything you could have looked up, anything about benefits at this stage, and "no, I think you covered everything" — which is the only genuinely bad answer available, because it says you have not been imagining the job.`,
    takeaway: 'Ask what success looks like, what surprises people, and what they are least sure how to build.',
  },

  {
    id: 'post-round-ten-minutes',
    kind: 'lesson',
    track: 'general',
    title: 'The ten minutes after the round',
    tags: ['structure'],
    difficulty: 'easy',
    body: `The round ends and the details evaporate within the hour. Spend ten minutes while it is still warm:

Write the questions down VERBATIM, as best you can. Companies reuse them, and your own list is worth more than any question bank.

Write the one moment you fumbled, and the answer you wish you had given. That sentence is what you actually practise next.

Write what you did well, specifically. Not for morale — so you keep doing it deliberately rather than by accident.

Then stop. Do not relitigate the round for three days; there is no information left in it after ten minutes.

If the round was recorded here, the report answers the first and third of those better than memory does. The second one is still yours to write, and it is the one that changes the next round.`,
    takeaway: 'Ten minutes after: verbatim questions, the one fumble with its better answer, what worked. Then stop.',
  },

  {
    id: 'quiz-behavioural-we',
    kind: 'quiz',
    track: 'behavioural',
    title: 'Which answer scores higher?',
    tags: ['clarity', 'confidence'],
    difficulty: 'easy',
    body: 'Asked about a project you are proud of, which opening is stronger?',
    choices: [
      '"We rebuilt the checkout flow and cut abandonment by 12 percent."',
      '"I owned the checkout rewrite. I chose to ship it behind a flag, and abandonment fell 12 percent."',
      '"It was a really challenging project with a lot of moving parts and great teamwork."',
      '"The team had been struggling with checkout for about two years before I joined."',
    ],
    answerIdx: 1,
    explanation:
      'It names what was yours, includes a decision with a reason, and attaches a number. The first is unscoreable — a good outcome with no visible contribution. The third is adjectives. The fourth is thirty seconds of situation before any task or action, which is the most common way a two-minute answer runs out of time.',
    takeaway: 'Ownership, one decision with its reason, one number. In the first sentence.',
  },

  {
    id: 'quiz-hr-current-salary',
    kind: 'quiz',
    track: 'hr',
    title: '"What are you making currently?"',
    tags: ['composure', 'confidence'],
    difficulty: 'medium',
    body: 'A recruiter asks for your current compensation on the first call. What is the strongest response?',
    choices: [
      'Give the real number — they will verify it anyway',
      'Inflate it slightly to raise the anchor',
      'Redirect to the budgeted range for the role, and give a researched target range if pressed',
      'Say you are not allowed to disclose it',
    ],
    answerIdx: 2,
    explanation:
      'Your current pay anchors the offer to what your last employer decided rather than to the value of this role, and in several jurisdictions the question is not permitted at all. Inflating it is a verifiable lie for a small gain. Redirecting to their band is normal and expected — recruiters have one, and asking for it is the cheapest leverage in the process.',
    takeaway: 'Redirect to their band. Your last salary is not evidence about this job.',
  },

  {
    id: 'quiz-dont-know',
    kind: 'quiz',
    track: 'general',
    title: 'A technology you have never used',
    tags: ['humility', 'followUpHandling'],
    difficulty: 'easy',
    body: 'You are asked how you would use a message broker you have genuinely never touched. What scores best?',
    choices: [
      'Reason from the general concepts and say plainly that you have not used this one',
      'Describe it in general terms without mentioning your lack of experience',
      'Say you do not know and wait for the next question',
      'Redirect to a technology you do know without answering',
    ],
    answerIdx: 0,
    explanation:
      'Interviewers score calibration — whether your confidence tracks your knowledge. Naming the gap and then reasoning toward the answer from an adjacent system demonstrates exactly that, and invites them to fill in what you are missing. A confident general description that turns out to be hollow is the one outcome that costs you more than the gap itself.',
    takeaway: 'Name the gap, then reason from something adjacent. Calibration is scored.',
  },

  /* ══ AI & LLM engineering ═══════════════════════════════════════════════════
     The track that did not exist when the rest of this bank was written, and
     the one most likely to come up in a 2026 interview loop for a role that is
     not an AI role. The angle throughout is ENGINEERING: nobody is asking you
     to derive attention, they are asking why the first token takes a second,
     what happens when retrieval returns nothing, and how you would know the
     prompt change you shipped made the answers better.

     Tagged `ai-engineering`, which is a real concept topic id — so a spoken
     round you fumble on this material pulls these cards forward. */

  {
    id: 'llm-what-it-is-doing',
    kind: 'lesson',
    track: 'concepts',
    title: 'What the model is actually doing',
    tags: ['ai-engineering'],
    difficulty: 'medium',
    body: `Between your prompt and the first word back:

Your text is split into tokens, each becomes a vector, and position information is added so order means something.

Attention lets each token pull in what is relevant from the others. In the decoder-only models you actually use, it is CAUSAL: a token attends to itself and everything before it, never ahead. That is what makes generation left to right, and what makes the key-value cache possible.

The output is a probability distribution over the NEXT token. One is sampled, appended to the input, and the whole thing runs again.

So generation is a loop, one token at a time. That single fact explains most of what you will be asked: why answers stream, why output costs more than input, why longer replies take longer in a way longer prompts do not, and why the model cannot revise something it has already said.

There is no lookup and no memory between calls. Everything it knows is in the weights, plus exactly what you put in the prompt.`,
    takeaway: 'It predicts one token, appends it, and repeats. No search, no memory, no revision.',
  },

  {
    id: 'llm-tokens-not-words',
    kind: 'lesson',
    track: 'concepts',
    title: 'A token is not a word',
    tags: ['ai-engineering', 'estimation'],
    difficulty: 'easy',
    body: `Rough English: one token is about four characters, so a hundred tokens is roughly seventy-five words. Useful for a napkin estimate and wrong everywhere it matters.

Code tokenizes far worse. Long identifiers, punctuation and indentation all split, so the same screenful costs noticeably more than prose. Non-English text can be several times worse again — which is a real fairness and cost issue, not a curiosity.

Two consequences worth stating in an interview:

A character count is a bad proxy for a bill. Count tokens with the provider's tokenizer.

The limit covers the WHOLE request — system instruction, every previous turn, retrieved documents, tool definitions, and the reply being generated. They all compete for one budget, and the reply loses when you get it wrong.`,
    takeaway: 'Tokens are sub-word units. Code and non-English cost far more per character than English prose.',
  },

  {
    id: 'llm-context-is-a-budget',
    kind: 'lesson',
    track: 'concepts',
    title: 'The context window is a budget, not a memory',
    tags: ['ai-engineering'],
    difficulty: 'medium',
    body: `The model does not remember your conversation. Your application re-sends it, every single turn. That is why turn twenty costs more than turn two for the same question.

When it no longer fits, nothing helpful happens automatically — the application must decide: drop the oldest turns, summarise them, or retrieve only the relevant ones. Doing that badly is exactly what "it forgot what we agreed" looks like.

And a bigger window is not free. Attention cost grows faster than linearly, so long contexts are slower as well as dearer, and accuracy sags for material buried in the middle of a very long input.

The engineering job is therefore context CURATION, not context maximisation: put the fewest, most relevant tokens in front of the model, in an order it can use.`,
    takeaway: 'History is re-sent every turn. Curate what goes in the window; do not just make it bigger.',
  },

  {
    id: 'llm-temperature-and-sampling',
    kind: 'lesson',
    track: 'concepts',
    title: 'Temperature, and why zero is not deterministic',
    tags: ['ai-engineering'],
    difficulty: 'medium',
    body: `The model gives a probability for every possible next token. Sampling picks one.

Temperature flattens or sharpens that distribution. High means more unlikely tokens get a chance — more variety, more nonsense. Near zero means nearly always take the most likely token.

Top-p (nucleus) sampling cuts the tail instead: consider only the smallest set of tokens whose probabilities add up to p. Usually tune one, not both.

The part people get wrong in interviews: temperature zero is not a guarantee of identical output. Batching, hardware and floating-point non-associativity mean the same request can still diverge. It is repeatable in practice, not deterministic by contract — so anything that must be exactly reproducible has to be cached or pinned by you, not hoped for.

Rule of thumb: extraction and classification near zero, drafting and brainstorming higher.`,
    takeaway: 'Temperature reshapes the distribution. Zero is near-greedy, not a determinism guarantee.',
  },

  {
    id: 'llm-first-token-latency',
    kind: 'lesson',
    track: 'concepts',
    title: 'Why the first token is the slow one',
    tags: ['ai-engineering', 'scalability'],
    difficulty: 'hard',
    body: `Inference has two phases with completely different costs.

PREFILL reads your whole prompt at once and builds the key-value cache. It is compute-heavy and scales with prompt LENGTH. This is your time to first token, and it is why a long retrieved context makes the reply feel late before a single word appears.

DECODE then emits one token at a time, each attending to that cache. It is memory-bandwidth-bound and scales with OUTPUT length, at a fairly steady tokens per second.

What follows:

Shortening the prompt improves time to first token. Shortening the answer improves total time. They are different fixes for different complaints.

Streaming changes nothing about total time and everything about how long it feels, which is usually the cheapest improvement available.

Throughput comes from batching many requests together, which is why a provider under load gets slower rather than failing.`,
    takeaway: 'Prefill sets time-to-first-token and scales with the prompt; decode scales with the answer.',
  },

  {
    id: 'llm-prompt-caching',
    kind: 'pattern',
    track: 'concepts',
    title: 'Put the stable part of the prompt first',
    tags: ['ai-engineering', 'caching'],
    difficulty: 'medium',
    body: `You see: the same long system instruction, tool list or document sent on every request, and a bill dominated by input tokens.

Reach for: prompt caching. Providers can reuse the computed state for an identical PREFIX, charging a fraction for the cached part and skipping its prefill.

The constraint is the whole design: it matches on an exact prefix, from the first token. One changing byte near the top — a timestamp, a user id, a randomly ordered list of tools — and the cache misses for everything after it.

So prompt layout becomes a cost decision. Static first: system instruction, tools, long reference documents, few-shot examples. Variable last: retrieved chunks, conversation, the user's question.

Measure the cache hit rate. An uninstrumented cache is indistinguishable from no cache, and the bill will not tell you which one you have.`,
    takeaway: 'Caching matches an exact prefix. Static content at the top, anything variable at the bottom.',
  },

  {
    id: 'llm-embeddings',
    kind: 'lesson',
    track: 'concepts',
    title: 'Embeddings: meaning as coordinates',
    tags: ['ai-engineering', 'databases'],
    difficulty: 'medium',
    body: `An embedding maps text to a vector positioned so that similar MEANING lands nearby. "How do I reset my password" and "I cannot log in" share almost no words and sit close together.

That is what keyword search cannot do, and it is the whole reason vector search exists.

Three things to know before you use one:

Vectors from different models are not comparable. Changing the embedding model means re-embedding the entire corpus. It is a migration, not a config change.

Similarity is not relevance. Nothing in a cosine distance can express "must contain this exact error code", which is why exact identifiers, names and numbers still belong to lexical search.

Store metadata beside the vector — tenant, source, date, permissions — because filtering is what makes retrieval correct rather than merely plausible.`,
    takeaway: 'Embeddings find paraphrases, not exact terms. Changing the model means re-embedding everything.',
  },

  {
    id: 'llm-vector-search-ann',
    kind: 'lesson',
    track: 'concepts',
    title: 'What a vector database is really doing',
    tags: ['ai-engineering', 'databases', 'scalability'],
    difficulty: 'hard',
    body: `Exact nearest neighbour over millions of vectors means comparing against all of them. So production uses APPROXIMATE nearest neighbour, and approximate is the point rather than a compromise you forgot to mention.

The common index is a navigable small-world graph: entry at a sparse top layer, greedily hop toward the query, descend to denser layers. Build parameters trade index size and build time against recall; the search parameter trades latency against recall at query time.

That means recall is a dial you set. Measure it against an exact search on a sample, or you are guessing.

The other honest answer in a system design round: you may not need a dedicated vector database at all. Postgres with pgvector is enough for millions of vectors and keeps your filters, joins and transactions in one place. A separate store earns its keep at a scale you should be able to state.`,
    takeaway: 'ANN trades recall for speed — measure the recall. Below a few million vectors, pgvector is usually enough.',
  },

  {
    id: 'llm-chunking',
    kind: 'pattern',
    track: 'concepts',
    title: 'Chunking decides retrieval quality',
    tags: ['ai-engineering'],
    difficulty: 'medium',
    body: `You see: retrieval returning passages that are almost right, or right but missing the sentence that mattered.

The cause is nearly always chunking, not the model.

Too small and each chunk loses the context that made it meaningful — a table row with no header, a "it" with no antecedent. Too large and the embedding averages several topics into a vector that is close to nothing in particular.

What works, in order of how much it buys you:

Split on STRUCTURE first — headings, sections, function boundaries. A chunk that is a whole idea beats a chunk that is a fixed number of characters.

Overlap by a sentence or two, so an answer that straddles a boundary survives.

Carry the parent context into the chunk text: document title, section heading, and for code the file path and signature.

Retrieve small, then expand: match the precise chunk but hand the model its neighbours.`,
    takeaway: 'Split on structure, overlap a little, carry the heading into the chunk. Fixed-size splitting is the floor.',
  },

  {
    id: 'llm-hybrid-and-rerank',
    kind: 'pattern',
    track: 'concepts',
    title: 'Hybrid search, then rerank',
    tags: ['ai-engineering', 'databases'],
    difficulty: 'hard',
    body: `You see: vector search that misses the document containing the exact error code, or returns five plausible passages of which the right one is fourth.

Reach for two stages.

HYBRID retrieval: run lexical (BM25) and vector search together and fuse the rankings — reciprocal rank fusion is the simple, robust default. Lexical catches identifiers, names and rare terms; vectors catch paraphrase. Neither alone is enough for real corpora.

RERANKING: take the top fifty and score each one against the query with a cross-encoder, which reads the query and the passage TOGETHER rather than comparing two independent vectors. Far more accurate, far too slow to run over the whole corpus — hence two stages.

Cost it honestly: a rerank adds tens to hundreds of milliseconds. Worth it, because putting the right passage first is the single biggest lever on answer quality, and it is cheaper than a bigger model.`,
    takeaway: 'Retrieve wide with lexical plus vector, then rerank the top fifty with a cross-encoder.',
  },

  {
    id: 'llm-rag-shape',
    kind: 'pattern',
    track: 'concepts',
    title: 'The RAG pipeline, end to end',
    tags: ['ai-engineering', 'api-design'],
    difficulty: 'medium',
    body: `INGEST, offline: load, split into chunks, embed, store with metadata. Re-run on change, and track which version of the embedding model produced each vector.

QUERY, per request: embed the question, retrieve candidates (lexical plus vector), rerank, assemble the prompt, generate with citations, validate.

The three rules that separate a demo from a product:

The prompt must say answer ONLY from the context, and must make "I do not know" an acceptable, expected answer rather than a failure.

Citations back to chunk ids are not decoration. Without them nobody can tell a grounded answer from a fluent one, including you.

Retrieved text is UNTRUSTED input. It came from a document someone else wrote, and it can contain instructions.

And permissions belong in the retrieval filter, not in the prompt. Asking the model not to mention a document it was given is not access control.`,
    takeaway: 'Ingest offline, retrieve-rerank-generate online, cite everything, and filter by permission before retrieval.',
  },

  {
    id: 'llm-rag-debug-order',
    kind: 'pattern',
    track: 'concepts',
    title: 'When RAG gives a wrong answer, look here first',
    tags: ['ai-engineering'],
    difficulty: 'medium',
    body: `Debug in this order. It is almost never the prompt, and almost never the model.

One. Is the answer even in the corpus? Half of all RAG bugs are a missing or stale document. Check before anything else.

Two. Did retrieval return the right chunk at all? Log the retrieved chunk ids and scores for every request. If the right chunk is not in the top fifty, no prompt will save you.

Three. Was it ranked high enough to survive the cut? If it was fortieth, that is a reranking problem.

Four. Was it mangled? Read the chunk as the model received it — a table flattened into noise, a heading lost, half a sentence.

Five. ONLY now, the prompt and the model.

The tooling that makes this possible is the retrieval log. Without per-request chunk ids and scores, every RAG investigation is guesswork with a confident narrator.`,
    takeaway: 'Corpus, retrieval, ranking, chunk quality, then the prompt. Log chunk ids and scores per request.',
  },

  {
    id: 'llm-rag-vs-finetune',
    kind: 'lesson',
    track: 'concepts',
    title: 'Prompt, retrieve, or fine-tune',
    tags: ['ai-engineering'],
    difficulty: 'medium',
    body: `The distinction that answers the question: retrieval adds KNOWLEDGE, fine-tuning shapes BEHAVIOUR.

"The model does not know our product" is missing knowledge. That is retrieval.

"The model will not stick to our format, tone or taxonomy, even with examples" is behaviour. That may be fine-tuning.

Try them in cost order, because each is a cheaper experiment than the next: prompting and few-shot examples, then retrieval, then fine-tuning.

Two things people miss. Facts change and weights do not, so anything that goes stale must be retrievable rather than trained in. And a fine-tune pins you to one base model version — when it is deprecated you repeat the run, with the dataset you had better have kept.

The real cost of fine-tuning is never the compute. It is curating and maintaining the dataset, and the eval set you held back to prove it worked.`,
    takeaway: 'Missing facts means retrieval. Wrong behaviour may mean fine-tuning. Prompt first, always.',
  },

  {
    id: 'llm-hallucination',
    kind: 'lesson',
    track: 'concepts',
    title: 'Hallucination is the mechanism working normally',
    tags: ['ai-engineering'],
    difficulty: 'medium',
    body: `The model is optimised to produce plausible continuations, not true ones. A fluent invented policy is not a crash — it is the same machinery that produces the correct answers, applied where it has nothing to go on.

Which is why "tell it not to hallucinate" does not work, and why a bigger model reduces the rate without removing the failure mode.

What actually moves the number:

Ground it. Retrieve real context and require citations you can check.

Make ignorance acceptable. If the only allowed outputs are answers, you have asked for an invention.

Constrain the shape. An enumeration cannot be invented; a free-text policy name can.

Verify identifiers. Anything that looks like an id, an order number or a link gets checked against a real system before it is shown.

Then measure. An eval set of real questions, graded, tracked across releases — otherwise every mitigation is a story you tell.`,
    takeaway: 'Ground, permit "I do not know", constrain the output shape, verify identifiers — then measure the rate.',
  },

  {
    id: 'llm-structured-output',
    kind: 'lesson',
    track: 'concepts',
    title: 'Structured output your code can trust',
    tags: ['ai-engineering', 'api-design'],
    difficulty: 'easy',
    body: `Ask for JSON in prose and you will parse JSON out of prose forever. Use the provider's schema-constrained output, which restricts generation to tokens that keep the output valid.

Then validate against your own schema anyway. The boundary belongs in your code, not in a vendor promise.

Three details that decide whether this is reliable:

Every field that might be unknown is REQUIRED and nullable. Optional fields let the model omit rather than answer, and a missing key and an unknown value become indistinguishable.

Invalid JSON is usually TRUNCATION — you hit the output token limit. That is a length bug, not a parsing bug, and patching it with a bracket-balancer hides a cut-off answer.

Retry with the validation error fed back, bounded to one or two attempts, and log the failure rate. A rising rate is telling you something about the schema or the prompt.`,
    takeaway: 'Constrained generation plus your own validation. Nullable-required fields, and treat invalid JSON as truncation.',
  },

  {
    id: 'llm-tool-calling',
    kind: 'pattern',
    track: 'concepts',
    title: 'How a text model does something',
    tags: ['ai-engineering', 'api-design'],
    difficulty: 'medium',
    body: `The model cannot call anything. It emits a structured request naming a tool and its arguments. YOUR code validates it, executes it, and feeds the result back as another message. Then it decides again.

That loop is the whole of tool use, and saying it out loud is most of the answer:

  you: here is the task, and the tools you may ask for
  model: call search_orders(customer=42)
  you:   validate, authorise, execute, return the rows
  model: the order shipped on Tuesday

Two things follow immediately.

Arguments are untrusted input. They arrive from a probabilistic text generator via a user who may be hostile. Validate types and authorise against the USER's permissions — never the agent's.

Tool definitions cost context on every single call. A long tool list is both a bill and an accuracy problem; the model picks worse from thirty tools than from six.`,
    takeaway: 'The model requests, your code executes. Validate arguments and authorise as the user, every time.',
  },

  {
    id: 'llm-agent-loop-bounds',
    kind: 'lesson',
    track: 'concepts',
    title: 'An agent is a loop, and loops need bounds',
    tags: ['ai-engineering', 'reliability'],
    difficulty: 'hard',
    body: `Observe, decide, act, repeat. That is an agent. It is not a new kind of intelligence; it is a while loop whose condition is a model's opinion.

So give it what you would give any loop that calls a paid API:

A step limit, a wall-clock limit and a token or cost ceiling. All three, because they fail differently.

A terminal state it can actually reach, and a defined answer for "gave up" that is not silence.

Progress detection. The characteristic failure is not an explosion, it is the same failing tool call four times with slightly different arguments. Detect repetition and break.

Idempotency on every side-effecting tool, because retries are normal here.

A human confirmation step for anything irreversible or outbound — money, deletion, email to a customer.

And an audit trail of every call and result. When an agent does something surprising, the transcript is the only evidence that exists.`,
    takeaway: 'Bound steps, time and cost; detect repetition; confirm anything irreversible; log every call.',
  },

  {
    id: 'llm-prompt-injection',
    kind: 'lesson',
    track: 'concepts',
    title: 'Prompt injection has no prompt-level fix',
    tags: ['ai-engineering', 'security'],
    difficulty: 'hard',
    body: `Instructions and data arrive through the same channel: tokens. So any content in the context can read as an instruction, and no system prompt can reliably outrank it.

DIRECT injection comes from the user, who is at least visible. INDIRECT injection comes from content your system fetched — a web page, a PDF, an email, a code comment, a support ticket. That is the dangerous one, because nobody decided to trust it and it can arrive long after the feature shipped.

The defence is architectural and lives outside the model:

Least privilege on tools. An assistant that can only read cannot be talked into writing.

Authorisation per action, checked against the real user, every time.

Confirmation for anything irreversible or outbound. This is the control that actually holds when everything else is bypassed.

Model output is untrusted too. Never concatenate it into a shell command, a query or a URL without validation.

Delimiters and instruction hierarchies raise the bar. They are mitigations, not controls, and an interviewer will know the difference.`,
    takeaway: 'Same channel for data and instructions. Contain it with permissions and confirmation, not with wording.',
  },

  {
    id: 'llm-evals',
    kind: 'lesson',
    track: 'concepts',
    title: 'Testing something that answers differently every time',
    tags: ['ai-engineering', 'reliability'],
    difficulty: 'hard',
    body: `You cannot assert equality, so build a ladder of weaker checks and run them over a set.

DETERMINISTIC first, wherever it is possible: is the JSON valid, does it cite a real document, is the extracted total equal to the invoice total, does it avoid the forbidden phrase. Most of what matters is checkable.

REFERENCE comparison next, for tasks with a right answer.

MODEL-AS-JUDGE last, for open-ended quality — with a fixed rubric, a pinned model, and its agreement with human labels measured at least once. An unvalidated judge is a ruler that changes length between releases.

Then treat it statistically. Run N times at fixed temperature and compare PASS RATES, with a threshold. One run against one run is noise wearing a result's clothes.

The eval set is the asset: real cases, every incident that ever reached a user, versioned in the repo. And prompts are versioned artefacts with a rollback path, exactly like code.`,
    takeaway: 'Deterministic checks, then references, then a validated judge — and compare pass rates, never single runs.',
  },

  {
    id: 'llm-cost-model',
    kind: 'lesson',
    track: 'concepts',
    title: 'Where the money actually goes',
    tags: ['ai-engineering', 'estimation'],
    difficulty: 'medium',
    body: `Priced per token, input and output separately, with output typically several times dearer. Two consequences dominate every bill.

The conversation is re-sent every turn, so a long chat is quadratic in cost across the session. Retrieved context is usually the largest single item.

Output length is the other half, and it is the one you can control directly by asking for less.

The levers, in the order they pay:

Measure tokens per request, split by input, cached input and output. Nothing else is worth doing first.

Route by difficulty. Classification, extraction and routing go to a small cheap model; the expensive one handles what actually needs it.

Cache the stable prefix, and lay the prompt out so there is one.

Retrieve fewer, better chunks. Rerank instead of stuffing twenty passages in.

Report cost per COMPLETED TASK, not per call. Per-call cost hides retries, and retries are where the surprise lives.`,
    takeaway: 'Input is re-sent every turn and output costs more. Measure tokens, route by difficulty, cache the prefix.',
  },

  {
    id: 'llm-model-routing',
    kind: 'pattern',
    track: 'concepts',
    title: 'Do not send everything to the big model',
    tags: ['ai-engineering', 'scalability'],
    difficulty: 'medium',
    body: `You see: one expensive model behind every call, including "is this question about billing or shipping".

Reach for a router. Cheap deterministic work first, small model next, large model only where it earns the price.

A real ladder for an assistant:

  intent and routing        small model, or a classifier, milliseconds
  extraction to a schema    small model at temperature zero
  retrieval and reranking   no generative model at all
  the actual answer         large model, with the curated context
  verification              small model, or code

Two rules keep it honest. Every hop is latency as well as cost — three sequential calls at four hundred milliseconds is over a second before anything renders. And every hop needs the same eval treatment, because a cheap classifier that is wrong four percent of the time sends four percent of users down the wrong path invisibly.

Degrade deliberately: if the large model is rate-limited, fall back and SAY the answer is degraded rather than pretending.`,
    takeaway: 'Small models for routing and extraction, the large one for the answer — and budget the latency of each hop.',
  },

  {
    id: 'llm-streaming-ux',
    kind: 'lesson',
    track: 'concepts',
    title: 'Streaming is a latency fix that changes no latency',
    tags: ['ai-engineering', 'api-design'],
    difficulty: 'easy',
    body: `The answer takes the same six seconds either way. Shown from the first token, it feels responsive; shown at the end, it feels broken. Perceived latency is the product.

What it costs you architecturally is worth knowing before you promise it:

You cannot validate what you have already sent. Anything that needs a schema check, a safety filter or a citation check either buffers or streams optimistically and corrects — and correcting visibly is worse than waiting.

Errors arrive mid-response, after a 200. Your client needs a protocol for a failure in the middle of a successful stream.

Server-sent events over HTTP is the usual transport and is enough for one-way token streams; a WebSocket is for genuinely bidirectional work such as live audio.

And cancellation matters: a user who navigates away should abort the upstream call, or you are paying for tokens nobody will read.`,
    takeaway: 'Stream for perceived latency, and plan for mid-stream errors, cancellation, and what you cannot validate.',
  },

  {
    id: 'llm-context-engineering',
    kind: 'pattern',
    track: 'concepts',
    title: 'Where things go in the prompt',
    tags: ['ai-engineering'],
    difficulty: 'medium',
    body: `Order is not cosmetic. Attention is not uniform across a long input: material at the very start and very end is used more reliably than material buried in the middle.

A layout that works, top to bottom:

  role and rules            stable, cacheable, rarely changes
  tools and schemas         stable
  few-shot examples         stable
  retrieved context         variable, clearly delimited and labelled with sources
  conversation history      variable
  the actual question       last, because recency is the strongest position

That is also exactly the order prompt caching wants, which is a pleasant coincidence worth naming in an interview: the cheap layout and the accurate layout are the same layout.

Two habits: delimit retrieved content explicitly so the model can tell YOUR instructions from SOMEONE ELSE'S text, and put the instruction about what to do with the context after the context, not before it.`,
    takeaway: 'Stable instructions first, the question last, retrieved text delimited in between. Cheap and accurate agree.',
  },

  {
    id: 'llm-quotas-and-fallbacks',
    kind: 'lesson',
    track: 'concepts',
    title: 'The provider will rate limit you',
    tags: ['ai-engineering', 'reliability'],
    difficulty: 'medium',
    body: `Treat the model as an unreliable third-party dependency with a quota, because that is what it is. Limits come as requests per minute, tokens per minute and tokens per day, and you will hit whichever you did not plan for.

What a production integration has:

A chain, not a model. Primary, then a fallback with different capacity, then a small model, then an honest failure. Degraded answers should say they are degraded.

Retry with exponential backoff and jitter on 429 and 503, respecting Retry-After, and a cap. Retries without jitter turn a rate limit into a self-inflicted outage.

A circuit breaker, so a provider incident fails fast instead of holding every worker.

A pinned model version, because "latest" changes behaviour under a prompt tuned for something else. Deprecation is a certainty, so the integration sits behind your own interface.

And queue anything that is not interactive. Batch endpoints are much cheaper and the user was never waiting.`,
    takeaway: 'Chain models, back off with jitter, break the circuit, pin the version — and batch anything non-interactive.',
  },

  {
    id: 'llm-privacy-boundary',
    kind: 'lesson',
    track: 'concepts',
    title: 'What you are allowed to put in the prompt',
    tags: ['ai-engineering', 'security'],
    difficulty: 'medium',
    body: `Every prompt is data leaving your system. That makes it a design constraint, not a legal footnote, and it is a question interviewers increasingly ask.

The things to have an answer for:

Retention and training. Does the provider train on your inputs, and for how long are they kept? Enterprise terms usually differ from the default ones, and "we use the free tier" is a real answer to a real question.

Minimisation. Send the fields the task needs. Redacting identifiers before the call and re-inserting them after is cheap and often enough.

Residency. Which region processes it, and does that satisfy the contract you signed with your own customers.

Logging. Prompt logs are the most useful debugging artefact you have and a copy of everything sensitive that passed through. Scrub, restrict and expire them.

Tenancy. One customer's document must be unreachable from another's retrieval. That is a filter in the query, not a line in the prompt.`,
    takeaway: 'A prompt is data leaving your system. Minimise it, know the retention terms, and scrub the logs.',
  },

  /* ── AI quizzes ─────────────────────────────────────────────────────────── */

  {
    id: 'quiz-llm-context-cost',
    kind: 'quiz',
    track: 'concepts',
    title: 'Turn twenty costs more than turn two',
    tags: ['ai-engineering', 'estimation'],
    difficulty: 'easy',
    body: 'A chat feature gets steadily more expensive per message as a conversation continues. Why?',
    choices: [
      'The model gets slower as its memory fills up',
      'The whole conversation is re-sent as input on every request',
      'Later answers are longer than earlier ones',
      'The provider charges more after a usage threshold',
    ],
    answerIdx: 1,
    explanation:
      'The model holds no state between calls, so your application re-sends the entire history every turn. Input tokens therefore grow with the conversation and the cost across a session grows quadratically. It is also why history management — summarising, truncating or retrieving selectively — is an engineering decision rather than a nicety.',
    takeaway: 'No memory between calls: you re-send the history, and you pay for it every time.',
  },

  {
    id: 'quiz-llm-finetune-facts',
    kind: 'quiz',
    track: 'concepts',
    title: 'It does not know our pricing',
    tags: ['ai-engineering'],
    difficulty: 'medium',
    body: 'Your assistant gives outdated prices. Pricing changes weekly. What is the right fix?',
    choices: [
      'Fine-tune the model on the current price list',
      'Retrieve the current prices at query time and ground the answer in them',
      'Put the full price list in the system prompt permanently',
      'Raise the temperature so it is less confident',
    ],
    answerIdx: 1,
    explanation:
      'Weights are frozen at training time, so anything that changes weekly cannot live in them — a fine-tune would be stale by the next release and you would repeat the run forever. The system prompt is better but pays for the entire list on every request and still needs a deploy to change. Retrieval keeps the facts in a store you can update, and lets the answer cite what it used.',
    takeaway: 'Facts that change belong in retrieval. Fine-tuning shapes behaviour, not knowledge.',
  },

  {
    id: 'quiz-llm-injection-source',
    kind: 'quiz',
    track: 'concepts',
    title: 'Where the injection came from',
    tags: ['ai-engineering', 'security'],
    difficulty: 'hard',
    body: 'Your agent summarises support tickets and can send email. A customer writes a ticket containing instructions to forward the thread elsewhere. What actually prevents the leak?',
    choices: [
      'A system prompt that says to ignore instructions inside tickets',
      'Delimiting the ticket text clearly in the prompt',
      'Requiring human confirmation before any outbound email',
      'Using a larger model that is harder to trick',
    ],
    answerIdx: 2,
    explanation:
      'Instructions and data share one channel, so every prompt-level defence is a mitigation that raises the bar rather than a control that holds. The boundary that holds is outside the model: the agent may draft, but a human authorises anything outbound or irreversible. Delimiting and instruction hierarchies are worth doing and are not the answer to "what prevents it".',
    takeaway: 'Prompt wording mitigates injection. Permissions and confirmation are what prevent it.',
  },

  {
    id: 'quiz-llm-first-token',
    kind: 'quiz',
    track: 'concepts',
    title: 'Slow to start, fine after that',
    tags: ['ai-engineering', 'scalability'],
    difficulty: 'hard',
    body: 'Users say the assistant takes ages to start answering, though it reads quickly once it begins. You retrieve twenty chunks per request. What do you change first?',
    choices: [
      'Switch to a faster model',
      'Retrieve fewer, better chunks so the prompt is shorter',
      'Ask the model for shorter answers',
      'Increase the output token limit',
    ],
    answerIdx: 1,
    explanation:
      'Time to first token is dominated by prefill, which scales with PROMPT length — twenty chunks is the prompt. Shorter answers improve total time but not the wait before the first word, which is the complaint. Reranking to five good chunks usually improves accuracy at the same time, which is why it is the first move rather than a model swap.',
    takeaway: 'Slow first token means a long prompt. Slow overall means a long answer.',
  },

  {
    id: 'quiz-llm-eval-method',
    kind: 'quiz',
    track: 'concepts',
    title: 'Did the prompt change help?',
    tags: ['ai-engineering', 'reliability'],
    difficulty: 'medium',
    body: 'You tweak a prompt, run your eval set once before and once after, and the score rises from 82 to 85. What should you conclude?',
    choices: [
      'It is an improvement — ship it',
      'Not much: one run against one run cannot separate the change from sampling variance',
      'It is a regression, since small gains usually reverse',
      'Nothing, because eval sets cannot measure prompt changes',
    ],
    answerIdx: 1,
    explanation:
      'Generation is stochastic, so a single pair of runs conflates the effect with run-to-run variance. Repeat N times at fixed temperature on both sides and compare the distributions, with a threshold you agreed in advance. This is also why the eval set must be large and stable enough that a three-point move means something.',
    takeaway: 'Compare pass rates across repeated runs, never one run against one run.',
  },

  {
    id: 'quiz-llm-embedding-migration',
    kind: 'quiz',
    track: 'concepts',
    title: 'A better embedding model came out',
    tags: ['ai-engineering', 'databases'],
    difficulty: 'medium',
    body: 'You switch to a new embedding model for incoming documents but leave existing vectors in place. What happens?',
    choices: [
      'Retrieval quality improves gradually as new documents arrive',
      'Nothing changes until you rebuild the index',
      'Retrieval breaks, because vectors from different models are not comparable',
      'Only documents longer than the new model’s limit are affected',
    ],
    answerIdx: 2,
    explanation:
      'Each model defines its own coordinate space. Distances between vectors from two different models are meaningless, so the mixed index ranks arbitrarily — often worse than either model alone, and silently. Changing the embedding model always means re-embedding the whole corpus, which is why the model version belongs in the metadata beside each vector.',
    takeaway: 'Two embedding models, one index, meaningless distances. Re-embed everything.',
  },

  /* ══ Interviewing in the AI era ═════════════════════════════════════════════
     Questions that did not exist three years ago and are now asked in almost
     every loop, including for roles with no AI in them. Tagged with delivery
     dimensions because that is what they are actually scored on. */

  {
    id: 'ai-tools-in-your-workflow',
    kind: 'lesson',
    track: 'general',
    title: '"How do you use AI in your work?"',
    tags: ['reasoning', 'humility', 'clarity'],
    difficulty: 'medium',
    body: `Asked in nearly every loop now, and it is not small talk. They are testing judgement — whether you know where these tools are strong and where they quietly cost you.

The answer that lands has three parts.

WHERE IT PAYS, specifically. Boilerplate, unfamiliar API surfaces, test scaffolding, a first draft of a migration, explaining a codebase you have just joined. Name a real task, not a category.

WHERE YOU DO NOT. Anything where you cannot check the output — a security boundary, a concurrency fix, a schema migration on production data. "I do not use it where I cannot review the result" is a strong sentence.

HOW YOU VERIFY. This is the part they are really listening for: you read it, you test it, you own it. "It compiled" is not verification.

The two failing answers are "I do not use it", which reads as incurious, and "I use it for everything", which reads as someone who has not yet been burned.`,
    takeaway: 'Name where it pays, where you refuse to use it, and exactly how you verify what it gives you.',
  },

  {
    id: 'ai-generated-code-ownership',
    kind: 'lesson',
    track: 'general',
    title: 'Code you did not write, that you are responsible for',
    tags: ['professionalism', 'humility'],
    difficulty: 'medium',
    body: `The follow-up to the last question, and the sharper one: what happens when the generated code is wrong in production?

The only defensible position is that authorship is irrelevant and ownership is total. You submitted it, you reviewed it, it is yours. Interviewers are checking for anyone who thinks otherwise, because that person is a liability on a team.

What a good answer contains:

You read every line before it goes in the pull request, and you can explain why each one is there. If you cannot explain it, it does not ship.

You are most sceptical where the model is most confident: plausible API calls that do not exist, subtly wrong error handling, and security-relevant code.

Licensing and secrets are a real concern, handled by policy rather than vibes.

And review comments are answered in your own words. "The assistant suggested it" is the one answer that cannot survive follow-up, in an interview or in a post-mortem.`,
    takeaway: 'Authorship does not transfer responsibility. If you cannot explain a line, it does not ship.',
  },

  {
    id: 'ai-in-system-design-rounds',
    kind: 'lesson',
    track: 'system_design',
    title: 'When the design question has an LLM in it',
    tags: ['ai-engineering', 'structure', 'scalability'],
    difficulty: 'hard',
    body: `"Design a support assistant over our documentation" is now a standard system design round, and it is scored like any other — except for four things candidates routinely miss.

The model is a third-party dependency with a quota and an outage history. Draw it as such: timeouts, fallbacks, a circuit breaker, a degraded path.

Retrieval is the real system. Ingestion pipeline, freshness, permissions per tenant, chunking, index rebuilds. Spend your time here — this is where the engineering is.

Evaluation is part of the architecture, not an afterthought. Where do eval cases come from, what gates a deploy, what do you watch in production.

Cost belongs on the diagram. Tokens per request, cache hit rate, cost per resolved conversation. An LLM design with no unit economics reads as someone who has never run one.

And say what happens when retrieval finds nothing. A design that has no answer for that has no answer for its most common request.`,
    takeaway: 'Treat the model as a flaky paid dependency; spend the round on retrieval, evals, cost and the empty-result path.',
  },

  /* ══ More DSA ═══════════════════════════════════════════════════════════════ */

  {
    id: 'tree-recursion-template',
    kind: 'pattern',
    track: 'dsa',
    title: 'Binary tree problems: what does the child return?',
    tags: ['Binary Tree', 'Depth-First Search', 'Recursion', 'Tree'],
    difficulty: 'medium',
    body: `You see: depth, balance, diameter, maximum path sum, "is this a valid BST", lowest common ancestor.

Almost all of them are one shape: recurse to the children, combine what they return, and return something upward.

The question that solves the problem is always the same — what does a child need to hand its parent? Often it is NOT the answer you were asked for. Diameter asks for the longest path anywhere, but a child can only usefully return its own height, while the answer is accumulated on the side.

That split — return one thing, record another — is the trick in the whole family. Say it out loud before coding and the implementation falls out.

Base case is null, and it returns the identity: zero height, empty result, negative infinity for a maximum.`,
    takeaway: 'Ask what a child returns to its parent. It is often not the answer — accumulate that separately.',
    codeLanguage: 'python',
    code: `def diameter(root):
    best = 0
    def height(node):
        nonlocal best
        if not node: return 0
        l, r = height(node.left), height(node.right)
        best = max(best, l + r)     # recorded on the side
        return 1 + max(l, r)        # returned upward
    height(root)
    return best`,
  },

  {
    id: 'bst-inorder-is-sorted',
    kind: 'pattern',
    track: 'dsa',
    title: 'In-order on a BST is a sorted list',
    tags: ['Binary Search Tree', 'Binary Tree', 'Depth-First Search'],
    difficulty: 'medium',
    body: `You see: kth smallest, validate a BST, closest value, convert to a sorted structure, find two nodes summing to a target.

The single fact that solves all of them: an in-order traversal of a binary search tree visits the values in sorted order.

So "kth smallest" is the kth step of an in-order walk — and you stop there, rather than collecting everything.

Validation is the one people get wrong. Checking each node against its two children is not enough; a value can be larger than its parent and still violate the tree further up. Carry a RANGE down instead, or check that the in-order sequence is strictly increasing.

Everything here is O(h) to descend, where h is the height — log n for a balanced tree, n for a degenerate one. Say which you are assuming.`,
    takeaway: 'In-order on a BST is sorted. Validate with a range carried downward, never by comparing to children.',
    codeLanguage: 'python',
    code: `def is_bst(node, lo=float('-inf'), hi=float('inf')):
    if not node: return True
    if not (lo < node.val < hi): return False
    return (is_bst(node.left, lo, node.val) and
            is_bst(node.right, node.val, hi))`,
  },

  {
    id: 'linked-list-reverse-template',
    kind: 'pattern',
    track: 'dsa',
    title: 'Reversing pointers, and the dummy head',
    tags: ['Linked List', 'Two Pointers', 'Recursion'],
    difficulty: 'easy',
    body: `Two habits make every linked list question easier.

REVERSAL is three pointers and four lines: hold the next node before you overwrite the link, or you have dropped the rest of the list. Write it until it is muscle memory — reorder, palindrome, reverse in k-groups and add-two-numbers all contain it.

A DUMMY HEAD removes every special case about the first node. Deleting, inserting or merging at the head is otherwise a separate branch that you will get wrong under pressure, and the whole trick is to return dummy.next at the end.

The other recurring move is splitting: find the middle with slow and fast, cut, then treat the halves independently. That is merge sort on a list, and it is how "reorder list" becomes three easy problems instead of one hard one.`,
    takeaway: 'Save next before overwriting. Use a dummy head so the first node is never a special case.',
    codeLanguage: 'python',
    code: `def reverse(head):
    prev, cur = None, head
    while cur:
        nxt = cur.next      # before anything is overwritten
        cur.next = prev
        prev, cur = cur, nxt
    return prev`,
  },

  {
    id: 'greedy-needs-an-argument',
    kind: 'lesson',
    track: 'dsa',
    title: 'Greedy is a claim, and you must argue it',
    tags: ['Greedy', 'Sorting', 'Dynamic Programming'],
    difficulty: 'hard',
    body: `Greedy algorithms are short and often wrong, and the interview is about which one you have.

Do not say "I will take the biggest each time" and start typing. Say WHY taking it cannot cost you later. The usual argument is an exchange: take any optimal solution, swap in the greedy choice, show it is no worse. Two sentences is enough, and it is what is being scored.

The tell that greedy fails: when a locally worse choice enables a better future. Coin change with arbitrary denominations breaks greedy for exactly this reason, and it is the standard follow-up.

When greedy does hold, it is usually after sorting, and the sort key is the argument — earliest END time for the most non-overlapping intervals, because ending sooner leaves the most room.

If you cannot make the argument, say so and reach for DP. "I think greedy works here but I cannot prove it, so let me do it correctly first" is a strong sentence, not a weak one.`,
    takeaway: 'Justify the greedy choice with an exchange argument, or use DP. Unargued greedy is a guess.',
  },

  {
    id: 'matrix-in-place-tricks',
    kind: 'pattern',
    track: 'dsa',
    title: 'Grid problems and the in-place constraint',
    tags: ['Matrix', 'Array', 'Depth-First Search'],
    difficulty: 'medium',
    body: `You see: rotate an image, set matrix zeroes, spiral order, islands, flood fill.

Two habits cover most of them.

Boundaries as four variables — top, bottom, left, right — shrink inward. That is spiral order, and it is far easier to keep right than index arithmetic.

Rotation in place is transpose then reverse each row. Say it before coding; deriving the index mapping live is how people lose ten minutes.

The in-place constraint is usually the actual question. "Set matrix zeroes with constant space" is asking you to store the marks IN the first row and column rather than in two sets — and to handle the overlap at cell zero-zero, which is the only hard part and the thing they are waiting for.

For traversal problems, mutate the grid as your visited set if you are allowed to, and say that you are: it is O(1) space instead of O(mn), and it is a deliberate trade, not a shortcut.`,
    takeaway: 'Rotate = transpose then reverse rows. Spiral = four shrinking bounds. In-place usually means mark inside the grid.',
  },

  {
    id: 'quiz-bst-validate',
    kind: 'quiz',
    track: 'dsa',
    title: 'Validating a BST',
    tags: ['Binary Search Tree', 'Depth-First Search'],
    difficulty: 'medium',
    body: 'A candidate validates a BST by checking, at every node, that the left child is smaller and the right child is larger. What is wrong?',
    choices: [
      'Nothing — that is the definition',
      'It fails for duplicate values only',
      'A node can satisfy its parent and still break an ancestor’s bound',
      'It is correct but runs in O(n log n)',
    ],
    answerIdx: 2,
    explanation:
      'The BST property is about whole subtrees, not immediate children. A value in the left subtree that is larger than the ROOT passes a local check against its own parent and still breaks the tree. The fix is to carry a permitted range down the recursion, narrowing it at each step, or to verify that an in-order traversal is strictly increasing.',
    takeaway: 'BST validity is a range carried down, not a comparison with children.',
  },

  /* ══ More core concepts ═════════════════════════════════════════════════════ */

  {
    id: 'kafka-partitions-and-ordering',
    kind: 'lesson',
    track: 'concepts',
    title: 'Kafka orders within a partition, and nowhere else',
    tags: ['kafka', 'distributed-systems'],
    difficulty: 'medium',
    body: `The guarantee is precise and the whole design follows from it: messages are ordered WITHIN a partition. Across partitions there is no order at all.

So the partition key is the design decision. Key by entity — order id, user id — and everything about that entity is ordered, while different entities parallelise freely.

Consequences to have ready:

Parallelism is capped by partition count. One consumer per partition within a group; extra consumers idle. Adding partitions later changes the key-to-partition mapping and therefore breaks ordering during the transition.

A hot key is a hot partition, and no amount of consumers fixes it.

Consumers commit OFFSETS, which is what makes redelivery normal: a crash between processing and committing replays the message. At-least-once again, so consumers must be idempotent.

And a rebalance stops the group briefly whenever membership changes, which is why a slow consumer that misses its poll interval can trigger one and make everything worse.`,
    takeaway: 'Order exists only within a partition, so the key is the design. Parallelism is capped by partition count.',
  },

  {
    id: 'docker-layers-and-caching',
    kind: 'lesson',
    track: 'concepts',
    title: 'Why your image rebuilds from scratch',
    tags: ['devops'],
    difficulty: 'easy',
    body: `An image is a stack of layers, and each instruction makes one. A layer is reused only if the instruction and everything before it are unchanged — so one early change invalidates the whole rest of the build.

Which is why the ordering rule exists: copy the dependency manifest and install dependencies BEFORE copying your source. Source changes every commit; the lockfile does not. Reversed, every build reinstalls everything.

Two more that come up:

Deleting a file in a later layer does not shrink the image. The bytes are still in the earlier layer, and that is how secrets end up permanently inside a published image. Multi-stage builds are the fix: build in one stage, copy only the artefact into a slim final stage.

The final image should not carry the toolchain. Compilers and dev dependencies are build-time, and shipping them is both size and attack surface.`,
    takeaway: 'Install dependencies before copying source, and use multi-stage builds. A deleted file still lives in its layer.',
  },

  {
    id: 'k8s-probes',
    kind: 'lesson',
    track: 'concepts',
    title: 'Liveness kills, readiness withholds traffic',
    tags: ['devops', 'reliability'],
    difficulty: 'medium',
    body: `Two probes that get conflated, with opposite consequences.

READINESS says "can I serve right now". Failing it removes the pod from the load balancer and nothing else. Use it for warm-up, for a lost database connection, for shedding load — anything temporary.

LIVENESS says "am I broken beyond recovery". Failing it RESTARTS the container. Use it only for genuine deadlock.

The classic outage is pointing liveness at a check that touches the database. The database gets slow, every pod fails liveness, every pod restarts simultaneously, and the restart storm makes the database worse. A readiness probe would have removed them from rotation and let them recover.

Two more details worth naming: a startup probe exists so a slow boot does not trip liveness, and terminating a pod must be graceful — stop accepting new work, finish in-flight requests, then exit, or every deploy drops requests.`,
    takeaway: 'Readiness for temporary, liveness for unrecoverable. Never point liveness at a dependency.',
  },

  {
    id: 'graphql-overfetch-and-n-plus-one',
    kind: 'lesson',
    track: 'concepts',
    title: 'What GraphQL fixes, and what it hands you',
    tags: ['api-design', 'databases'],
    difficulty: 'medium',
    body: `It solves a real problem: the client asks for exactly the fields it wants, so over-fetching and the endpoint-per-screen sprawl both go away, and one round trip replaces three.

What you inherit in exchange:

N+1 by default. Every field resolver runs independently, so a list of fifty posts each resolving an author is fifty-one queries. Batching per request — a dataloader — is not optional, it is the price of entry.

Query cost is now the client's choice. A deeply nested query can be enormously expensive, so you need depth limits, complexity scoring and persisted queries. An open GraphQL endpoint without them is a denial-of-service surface.

Caching gets harder. HTTP caching keys on the URL, and everything is one POST to one path. Caching moves into the server and the client.

Which is why REST plus a couple of purpose-built endpoints is often still the right answer, and saying so is a stronger response than picking a side.`,
    takeaway: 'GraphQL trades over-fetching for N+1, cost control and caching. Dataloaders and depth limits are mandatory.',
  },

  {
    id: 'realtime-transport-choice',
    kind: 'pattern',
    track: 'concepts',
    title: 'Polling, SSE or WebSocket',
    tags: ['api-design', 'networking', 'scalability'],
    difficulty: 'medium',
    body: `You see: "the client needs to know when something changes".

POLLING is fine more often than people admit. Simple, cacheable, stateless, survives every proxy. If seconds of delay are acceptable and the change rate is low, stop here.

SERVER-SENT EVENTS for one-way streams: notifications, progress, LLM tokens. Plain HTTP, automatic reconnection with an event id, works through most infrastructure. One connection per client, and older browsers cap connections per origin.

WEBSOCKETS for genuinely bidirectional, low-latency traffic: collaborative editing, live audio, games. You now own connection state, heartbeats, reconnection with backoff, and message ordering on reconnect.

The scaling question is the one that gets asked: connections are stateful, so a load balancer must be sticky or the state must be external, and an event for a user connected to another instance needs a pub-sub layer between them. That is the answer they are waiting for, not the protocol trivia.`,
    takeaway: 'Poll unless you cannot. SSE for one-way streams, WebSockets for bidirectional — and plan the fan-out across instances.',
  },

  {
    id: 'quiz-k8s-probe-outage',
    kind: 'quiz',
    track: 'concepts',
    title: 'Every pod restarted at once',
    tags: ['devops', 'reliability'],
    difficulty: 'hard',
    body: 'Your database slows down. Within a minute every application pod has restarted, repeatedly, and the outage is worse. What is the most likely cause?',
    choices: [
      'The readiness probe checks the database',
      'The liveness probe checks the database',
      'Autoscaling reacted to the latency',
      'The deployment rolled out during the incident',
    ],
    answerIdx: 1,
    explanation:
      'A failing liveness probe restarts the container. Pointing it at a shared dependency means a dependency incident becomes a cluster-wide restart storm, which drops in-flight work and hits the struggling database with reconnections. Readiness checking the database is defensible — it sheds traffic while the pod cannot serve — precisely because it does not kill anything.',
    takeaway: 'Liveness on a shared dependency turns one incident into a restart storm.',
  },

  /* ══ More system design ═════════════════════════════════════════════════════ */

  {
    id: 'multi-tenancy-isolation',
    kind: 'lesson',
    track: 'system_design',
    title: 'Three ways to keep tenants apart',
    tags: ['databases', 'scalability', 'security'],
    difficulty: 'hard',
    body: `SHARED TABLES with a tenant column. Cheapest to run, easiest to migrate, and one missing WHERE clause is a data breach. Mitigate in the layer that cannot be forgotten — row-level security in the database, or a repository that cannot build a query without a tenant.

SCHEMA PER TENANT. Real separation, familiar operations, and migrations now run N times. Fine at hundreds, painful at thousands.

DATABASE PER TENANT. Strongest isolation, per-tenant backup and residency, highest cost and operational load. This is what enterprise contracts and data residency requirements actually buy.

Most products start shared and move their largest tenants out, which is a good answer because it names the migration path rather than pretending one choice fits forever.

The part people forget: noisy neighbours. One tenant's bulk import must not consume the shared connection pool, so per-tenant quotas and rate limits are part of the isolation story, not a separate feature.`,
    takeaway: 'Shared, schema, or database per tenant. Enforce the filter where it cannot be forgotten, and quota the noisy ones.',
  },

  {
    id: 'webhooks-that-survive',
    kind: 'lesson',
    track: 'system_design',
    title: 'Receiving webhooks without losing events',
    tags: ['api-design', 'reliability', 'distributed-systems'],
    difficulty: 'medium',
    body: `The handler's only job is to accept the event and return 200 fast. Do the work inline and a slow database turns into a timeout, which turns into a redelivery, which turns into duplicate work.

So: verify, persist, enqueue, respond. Process asynchronously.

The rest of the checklist, all of it earned by real incidents:

VERIFY the signature before parsing, against the raw body — a JSON round trip changes bytes and breaks the HMAC.

DEDUPLICATE on the provider's event id, stored with a unique constraint. Redelivery is normal, not exceptional.

Events arrive OUT OF ORDER. Use the version or timestamp in the payload and ignore anything older than what you have applied. "Subscription cancelled" landing before "subscription created" is a real Tuesday.

Reconcile. Webhooks get dropped, so a periodic sweep that pulls the provider's current state and repairs drift is the difference between mostly right and right.`,
    takeaway: 'Verify on the raw body, dedupe on the event id, expect out-of-order delivery, and reconcile on a schedule.',
  },

  {
    id: 'deploy-strategies',
    kind: 'lesson',
    track: 'system_design',
    title: 'Rolling, blue-green, canary — and the flag',
    tags: ['devops', 'reliability'],
    difficulty: 'medium',
    body: `ROLLING replaces instances gradually. Cheap, and both versions run at once — which is a constraint on your database, not a detail.

BLUE-GREEN runs two full environments and flips traffic. Instant rollback, double the infrastructure during the switch.

CANARY sends a small share of real traffic to the new version and watches error rate and latency before continuing. The only one that catches problems that need production traffic to appear.

The thing that makes all three work is separating DEPLOY from RELEASE. Ship the code dark behind a feature flag, then turn it on for one percent. Rollback becomes a config change instead of a redeploy.

And the migration rule that decides whether any of this is survivable: schema changes must be backward compatible for at least one release. Add the column, write to both, backfill, switch reads, then drop the old one — several deploys, never one. A rollback into a schema that no longer exists is not a rollback.`,
    takeaway: 'Separate deploy from release with flags, and make every migration survivable by the previous version.',
  },

  /* ══ Containers, Kubernetes and Helm ════════════════════════════════════════ */

  {
    id: 'docker-pid-one',
    kind: 'lesson',
    track: 'concepts',
    title: 'Your container ignores SIGTERM',
    tags: ['devops', 'nodejs'],
    difficulty: 'medium',
    body: `Deploys drop requests and nobody can explain why. The cause is usually process one.

The SHELL form — CMD npm start — runs your process under /bin/sh, which becomes PID 1 and does not forward signals. Kubernetes sends SIGTERM, the shell ignores it, nothing shuts down, and thirty seconds later SIGKILL takes the container mid-request.

The EXEC form — CMD ["node", "server.js"] — makes your process PID 1, so it receives the signal.

But PID 1 has no default signal handlers, so an unhandled SIGTERM in Node is a no-op rather than an exit. You must handle it: stop accepting connections, finish in-flight work, close the database pool, exit.

And PID 1 is also responsible for reaping zombies. If your process spawns children, use a real init — tini, or Docker's --init.`,
    takeaway: 'Use the exec form, handle SIGTERM yourself, and add an init if you spawn children.',
    codeLanguage: 'javascript',
    code: `process.on('SIGTERM', async () => {
  server.close();            // stop accepting new connections
  await inFlight();          // let current requests finish
  await pool.end();
  process.exit(0);
});`,
  },

  {
    id: 'k8s-graceful-shutdown',
    kind: 'pattern',
    track: 'concepts',
    title: 'Why a rolling deploy still drops requests',
    tags: ['devops', 'reliability'],
    difficulty: 'hard',
    body: `Pod termination is two things happening CONCURRENTLY, not in order:

The kubelet sends SIGTERM to your container.
The endpoints controller removes the pod from Services.

The second is eventually consistent and propagates through kube-proxy or your ingress asynchronously. So a pod can receive SIGTERM while traffic is still being routed to it — and if it closes its listener immediately, those requests are refused.

The fix is a preStop hook that sleeps a few seconds before SIGTERM is sent. The pod keeps serving during the sleep while the removal propagates, and only then begins shutting down.

Then set terminationGracePeriodSeconds longer than the sleep plus your longest in-flight request, or SIGKILL arrives mid-work.

This is the single most common cause of five-hundreds during a deploy, and knowing it is a strong senior signal.`,
    takeaway: 'Endpoint removal is async. preStop sleep, then drain, with a grace period longer than both.',
  },

  {
    id: 'k8s-requests-and-limits',
    kind: 'lesson',
    track: 'concepts',
    title: 'Requests schedule, limits punish',
    tags: ['devops', 'nodejs'],
    difficulty: 'hard',
    body: `REQUESTS are what the scheduler reserves. They decide which node you land on and nothing else at runtime.

LIMITS are enforced, and the two resources behave completely differently:

CPU is throttled. Exceed it and the kernel stops scheduling your process for the rest of the period. Latency spikes with no error and no restart, which makes it genuinely hard to diagnose — watch for throttling metrics, not CPU usage.

MEMORY is not throttled. Exceed it and the container is OOM-killed and restarted.

For Node specifically: V8 does not read the cgroup limit by default on older versions, so it will happily grow past a 512Mi limit and get killed. Set --max-old-space-size below the container limit.

And a memory limit with no request, or a limit far above the request, makes the pod BestEffort or Burstable — first in line for eviction when the node is under pressure.`,
    takeaway: 'CPU limits throttle silently; memory limits kill. Set V8 heap below the container memory limit.',
  },

  {
    id: 'k8s-config-and-secrets',
    kind: 'lesson',
    track: 'concepts',
    title: 'A Kubernetes Secret is not encrypted',
    tags: ['devops', 'security'],
    difficulty: 'medium',
    body: `It is base64 encoded, which is not encryption. Anyone with get access to Secrets in the namespace can read it, and by default it sits in etcd in plaintext unless encryption at rest is switched on.

So the real controls are RBAC on the Secret, encryption at rest, and keeping the value out of Git entirely — sealed secrets, external secrets pulling from a real manager, or a CSI driver.

Two operational details that decide whether this works day to day:

A ConfigMap or Secret mounted as a VOLUME updates in place, eventually, without a restart. One consumed as an environment VARIABLE does not — env is set at process start and never changes. That is why config changes appear to do nothing.

So either watch the file, or roll the deployment. The usual trick is a checksum of the config in the pod template annotation, which changes the template and triggers a rollout automatically.`,
    takeaway: 'Secrets are base64, not encrypted. Env vars never update in place — roll the pod on config change.',
  },

  {
    id: 'k8s-service-types',
    kind: 'lesson',
    track: 'concepts',
    title: 'How traffic actually reaches a pod',
    tags: ['devops', 'networking'],
    difficulty: 'medium',
    body: `Every pod gets its own IP, and pods are disposable, so nothing addresses them directly.

A SERVICE is a stable virtual IP and DNS name in front of a changing set of pods, selected by label. ClusterIP is internal only. NodePort opens a port on every node. LoadBalancer asks the cloud for an external balancer — one per Service, which is why nobody uses it for every HTTP service.

An INGRESS is the layer-seven router: one external load balancer, host and path rules fanning out to many Services, TLS termination in one place.

Two things worth knowing beyond the definitions:

A Service load-balances per CONNECTION, not per request. Long-lived connections — gRPC, HTTP/2, WebSockets, a database pool — pin to one pod and stay there, so adding replicas does not rebalance existing traffic.

A headless Service returns pod IPs directly rather than a virtual IP, which is what StatefulSets and client-side balancing use.`,
    takeaway: 'Services balance connections, not requests. Long-lived connections pin to a pod until they reconnect.',
  },

  {
    id: 'k8s-statefulset-vs-deployment',
    kind: 'lesson',
    track: 'concepts',
    title: 'When a Deployment is the wrong object',
    tags: ['devops', 'databases'],
    difficulty: 'medium',
    body: `A DEPLOYMENT treats pods as interchangeable: random names, no ordering, any pod can be replaced by any other. That is right for stateless services and wrong for anything with identity.

A STATEFULSET gives each pod a stable ordinal name, a stable DNS entry, and its own persistent volume that follows it across restarts. Pods are created and terminated in order, which is what clustered databases and brokers need to bootstrap and to shut down without losing quorum.

A DAEMONSET runs exactly one pod per node — log collectors, metrics agents, network plugins.

A JOB runs to completion, and a CronJob schedules one.

The senior answer to "would you run Postgres in Kubernetes" is not yes or no. It is: a StatefulSet plus an operator that understands failover, backup and version upgrades — and unless you have a reason, a managed database is less work and fewer incidents.`,
    takeaway: 'Deployments for interchangeable pods, StatefulSets for identity and storage, DaemonSets for per-node agents.',
  },

  {
    id: 'k8s-debug-crashloop',
    kind: 'pattern',
    track: 'concepts',
    title: 'CrashLoopBackOff, in order',
    tags: ['devops', 'reliability'],
    difficulty: 'medium',
    body: `The status tells you the pod keeps dying, not why. Work the ladder:

kubectl describe pod — the Events at the bottom are the answer more often than the logs. Image pull failures, failed mounts, OOMKilled, probe failures all appear here and nowhere else.

kubectl logs --previous — the CURRENT container has just started and is usually empty. The crash is in the dead one.

Check the exit code. Zero means it finished and Kubernetes restarted it, so your process exited when it should not have. 137 is SIGKILL, usually OOM. 143 is SIGTERM.

If Events say OOMKilled, it is the memory limit, not your code — until you check whether the limit is honest.

If it starts and then dies at a steady interval, suspect a liveness probe failing during a slow boot. A startup probe is the fix, not a longer liveness period.`,
    takeaway: 'Events before logs, --previous for the crash, then the exit code: 137 is OOM, 143 is SIGTERM.',
  },

  {
    id: 'helm-what-it-buys',
    kind: 'lesson',
    track: 'concepts',
    title: 'What Helm is for, and where it hurts',
    tags: ['devops'],
    difficulty: 'medium',
    body: `A chart is a templated bundle of manifests plus a values file, versioned and installed as a named RELEASE. The point is one artefact per environment with the differences in values, and helm rollback to the previous revision.

Where it hurts, and what an interviewer is listening for:

It is string templating over YAML, not a typed model. Indentation bugs are runtime failures, which is why helm template and --dry-run belong in CI.

helm upgrade does a three-way merge against the last applied state. Anything changed by hand in the cluster, or by an autoscaler, can be reverted or fought over on the next deploy.

Secrets do not belong in values.yaml in Git. Use a secrets manager and reference it.

And a rollback rolls back MANIFESTS, not data. A schema migration that ran forward is still applied, which is why migrations must be backward compatible for a release — the same rule that makes any deploy strategy survivable.`,
    takeaway: 'Helm versions manifests, not data. Template in CI, keep secrets out of values, and keep migrations reversible.',
  },

  {
    id: 'quiz-k8s-cpu-limit',
    kind: 'quiz',
    track: 'concepts',
    title: 'Latency spikes, no restarts',
    tags: ['devops', 'reliability'],
    difficulty: 'hard',
    body: 'A service shows periodic latency spikes. No restarts, no errors, CPU usage sits below the limit on average. What do you check?',
    choices: [
      'Memory limits, since OOM kills are silent',
      'CPU throttling, because limits are enforced per short period',
      'The readiness probe interval',
      'Node disk pressure',
    ],
    answerIdx: 1,
    explanation:
      'CPU limits are enforced by the kernel as a quota per scheduling period. A burst that exhausts the quota is paused until the next period, which shows up as latency rather than as an error or a restart — and average CPU stays low precisely because the process was stopped. Throttling metrics are the signal; average utilisation hides it. Memory limits do not throttle, they kill.',
    takeaway: 'A CPU limit throttles per period. Average usage hides it — watch throttling, not utilisation.',
  },

  /* ══ Redis ══════════════════════════════════════════════════════════════════ */

  {
    id: 'redis-single-threaded',
    kind: 'lesson',
    track: 'concepts',
    title: 'Redis runs your commands one at a time',
    tags: ['databases', 'distributed-systems'],
    difficulty: 'medium',
    body: `Command execution is single-threaded. Newer versions add threads for reading and writing sockets, but the commands themselves still run one after another.

That is why Redis is atomic without you asking, and it is also the whole risk profile: one slow command blocks every other client.

The commands that do this, and what to use instead:

KEYS is O(n) over the entire keyspace. Use SCAN, which is cursor-based and incremental.

FLUSHALL, and deleting a huge collection with DEL, block for as long as the free takes. UNLINK frees in the background.

A Lua script runs atomically and therefore blocks for its whole duration. Keep them short.

Anything O(n) on a big collection — LRANGE over a million-element list, SMEMBERS on a huge set — is the same mistake wearing a different name.

So the operational rule is: no unbounded command, ever, and measure with SLOWLOG.`,
    takeaway: 'One command at a time. SCAN not KEYS, UNLINK not DEL, and nothing unbounded.',
  },

  {
    id: 'redis-memory-and-eviction',
    kind: 'lesson',
    track: 'concepts',
    title: 'The cache that ate the server',
    tags: ['databases', 'caching', 'reliability'],
    difficulty: 'hard',
    body: `Redis has no memory limit by default. A cache with no maxmemory and keys without TTLs grows until the machine is out of memory — and then the failure mode depends on the eviction policy you also did not set.

The default policy is noeviction: writes start failing with an error while reads keep working. A cache that returns errors instead of misses takes the application down with it.

So two settings, always: maxmemory, and a policy — allkeys-lru for a pure cache, volatile-lru when the same instance also holds data that must not be evicted.

Two more things that look like leaks and are not:

Expiry is lazy plus sampled. A key past its TTL still occupies memory until it is touched or the sampler reaches it, so memory lags deletion.

Fragmentation. Freed memory returns to the allocator, not the OS. Compare used_memory with used_memory_rss before concluding anything.

And find the real culprit with MEMORY USAGE and --bigkeys rather than guessing.`,
    takeaway: 'Set maxmemory and an eviction policy. Without them the default is to fail writes, not to evict.',
  },

  {
    id: 'redis-distributed-lock',
    kind: 'pattern',
    track: 'concepts',
    title: 'Locking with Redis, honestly',
    tags: ['distributed-systems', 'databases'],
    difficulty: 'hard',
    body: `You see: two workers processing the same job, or a cron running twice because two instances fired.

The minimum correct lock is one command: SET key token NX PX ttl. NX makes it atomic, PX guarantees it is released even if the holder dies, and the random token is what lets you release only your own lock — a plain DEL can delete a lock that has already expired and been taken by someone else. Release with a Lua script that compares then deletes.

Now the part that matters at senior level: this is not a correctness guarantee. If your work runs longer than the TTL, the lock expires while you are still holding it and a second worker starts. No amount of Redlock fixes that, because the process cannot know it has been paused.

So a lock like this is an OPTIMISATION that prevents duplicate work most of the time. Anything that must not happen twice needs idempotency or a fencing token checked by the resource itself.`,
    takeaway: 'SET NX PX with a token, release by compare-and-delete — and treat it as advisory, not as correctness.',
    codeLanguage: 'javascript',
    code: `const token = randomUUID();
const ok = await redis.set(key, token, 'NX', 'PX', 30000);

// release: only if it is still ours
await redis.eval(
  \`if redis.call("get", KEYS[1]) == ARGV[1]
      then return redis.call("del", KEYS[1]) else return 0 end\`,
  1, key, token,
);`,
  },

  {
    id: 'redis-persistence',
    kind: 'lesson',
    track: 'concepts',
    title: 'RDB, AOF, and the fork that doubles your memory',
    tags: ['databases', 'reliability'],
    difficulty: 'hard',
    body: `RDB is a point-in-time snapshot. Compact, fast to restore, and you lose everything since the last one.

AOF is an append-only log of write commands. Much smaller loss window, larger files, slower restart. fsync every second is the usual setting — always is durable and slow, never is fast and dishonest.

The operational trap is the FORK. Both snapshotting and AOF rewrite fork the process, and the child shares memory copy-on-write. A write-heavy instance during a fork can approach double the resident memory, which is how a Redis with plenty of headroom gets OOM-killed at exactly the moment it is saving.

So leave headroom, and know that the same fork causes the latency blip people blame on the network.

The senior framing: if Redis is a cache, persistence may be pure cost — restarting empty is fine and a stampede is the real risk. If it is a datastore, you need AOF, replication and a tested restore.`,
    takeaway: 'Forking to save can nearly double memory. Decide first whether Redis is a cache or a datastore.',
  },

  {
    id: 'redis-cluster-slots',
    kind: 'lesson',
    track: 'concepts',
    title: 'Multi-key commands and hash slots',
    tags: ['databases', 'distributed-systems', 'scalability'],
    difficulty: 'hard',
    body: `Redis Cluster shards by hashing the key into one of sixteen thousand three hundred and eighty-four slots, each owned by one node.

The consequence people meet in production: any command touching several keys requires them all to be in the SAME slot, or it is refused with a CROSSSLOT error. That includes MGET, transactions, and Lua scripts.

The fix is a hash tag — the part of the key in braces is what gets hashed. So user:{42}:profile and user:{42}:settings land together, deliberately.

Which makes key design a sharding decision. Over-tag and everything for one tenant lands on one node, and you have built a hot shard.

Also: a Cluster client must handle MOVED and ASK redirects during resharding, which is a reason to use a maintained client rather than a thin wrapper. And single-node Redis with replicas is simpler and enough far more often than people assume.`,
    takeaway: 'Multi-key commands need one slot. Hash tags control that — and over-tagging builds a hot shard.',
  },

  {
    id: 'quiz-redis-cache-error',
    kind: 'quiz',
    track: 'concepts',
    title: 'Redis filled up',
    tags: ['databases', 'caching'],
    difficulty: 'medium',
    body: 'Your Redis cache reaches the memory ceiling with the default configuration. What happens to the application?',
    choices: [
      'Old keys are evicted automatically to make room',
      'Writes begin failing with an error while reads still work',
      'Redis restarts and comes back empty',
      'Keys without a TTL are dropped first',
    ],
    answerIdx: 1,
    explanation:
      'The default policy is noeviction, so once maxmemory is reached Redis refuses writes with an error instead of evicting. A cache that errors rather than missing is worse than no cache — the application usually has no path for it. Setting maxmemory and allkeys-lru turns the ceiling into a cache behaving like a cache, which is the configuration people assume they already have.',
    takeaway: 'Default is noeviction: it errors rather than evicting. Set maxmemory and a policy explicitly.',
  },

  /* ══ Kafka, deeper ══════════════════════════════════════════════════════════ */

  {
    id: 'kafka-consumer-group-rebalance',
    kind: 'lesson',
    track: 'concepts',
    title: 'The rebalance that stops your consumers',
    tags: ['kafka', 'distributed-systems'],
    difficulty: 'hard',
    body: `Partitions are assigned to members of a consumer group. Any membership change triggers a rebalance, and with the classic protocol that is a stop-the-world pause for the whole group.

What triggers one, in the order people hit them:

A consumer misses max.poll.interval.ms because a single record took too long to process. The broker assumes it is dead and rebalances — and the consumer then finds its partitions gone when it tries to commit.

A deploy. Every rolling restart is a membership change.

A slow network or a missed heartbeat.

The fixes are specific: process faster or reduce max.poll.records, keep processing off the poll thread if it is genuinely long, and use cooperative sticky assignment so a rebalance moves only the partitions that must move instead of revoking everything.

And a consumer that is simply behind is not rebalancing at all — that is lag, and it is a throughput problem capped by the partition count.`,
    takeaway: 'Long processing trips max.poll.interval and forces a rebalance. Cooperative sticky assignment limits the damage.',
  },

  {
    id: 'kafka-acks-and-durability',
    kind: 'lesson',
    track: 'concepts',
    title: 'What acks actually promises',
    tags: ['kafka', 'reliability', 'distributed-systems'],
    difficulty: 'hard',
    body: `acks=0 is fire and forget. acks=1 means the leader wrote it — and if that leader dies before a replica catches up, the message is gone. acks=all means every in-sync replica has it.

But acks=all alone is not durability. It guarantees the in-sync replica set has it, and if the set has shrunk to just the leader, that is one copy with a stronger-sounding name.

So it is a pair: acks=all AND min.insync.replicas greater than one. With replication factor three and min.insync.replicas two, you survive one broker loss and the producer gets an error rather than silent data loss when you cannot.

On the consumer side, the mirror image: auto-commit acknowledges by a timer, so a crash can skip records you never processed. Commit after processing, and accept at-least-once with an idempotent consumer.

Kafka transactions give exactly-once WITHIN Kafka — consume, process, produce. They do not extend to your database.`,
    takeaway: 'acks=all only means the ISR has it. Pair it with min.insync.replicas, and commit offsets after processing.',
  },

  {
    id: 'kafka-retention-vs-compaction',
    kind: 'lesson',
    track: 'concepts',
    title: 'A log that expires, or a log that remembers',
    tags: ['kafka', 'databases'],
    difficulty: 'medium',
    body: `DELETE retention keeps messages for a time or a size, then drops the oldest segments. This is the default and suits events: what happened, in order, for a week.

COMPACTION keeps the LATEST message per key, forever. The topic becomes a changelog you can replay to rebuild current state — which is what makes a topic usable as a source of truth for a materialised view or a cache.

Two details that come up:

A tombstone — a message with a null value — is how you delete a key from a compacted topic.

Compaction is asynchronous and works on closed segments, so duplicates for a key exist until it runs. Consumers must tolerate that.

The design question this answers: replaying a compacted topic rebuilds state from scratch, which is how a new service bootstraps without a migration script. That, rather than storage cost, is why the choice matters.`,
    takeaway: 'Delete retention for events, compaction for the latest state per key. Tombstones delete; compaction is async.',
  },

  {
    id: 'kafka-vs-queue',
    kind: 'pattern',
    track: 'concepts',
    title: 'Kafka or a queue',
    tags: ['kafka', 'messaging', 'distributed-systems'],
    difficulty: 'medium',
    body: `They are not the same shape, and the wrong choice shows up months later.

A QUEUE (SQS, RabbitMQ) is work distribution. A message is consumed and removed, any worker can take any message, and scaling is adding workers. Per-message retry and dead-letter handling are built in. No ordering unless you ask for it, and FIFO costs throughput.

A LOG (Kafka) is a durable ordered sequence that many independent consumers read at their own offsets. The message is not removed when read, so a new consumer can replay history, and ordering holds within a partition.

Choose the log when you need replay, multiple independent consumers, or ordering per entity. Choose the queue when you need competing workers with straightforward retries and a dead-letter queue.

Retry is the honest weakness of the log: a poison message blocks its partition, because moving on means breaking the ordering the log exists to provide. You need a retry topic or a skip policy, and you should say so.`,
    takeaway: 'Queue for competing workers and easy retries; log for replay, fan-out and per-key ordering.',
  },

  /* ══ AWS and serverless ═════════════════════════════════════════════════════ */

  {
    id: 'lambda-cold-starts',
    kind: 'lesson',
    track: 'concepts',
    title: 'Cold starts, and what actually helps',
    tags: ['devops', 'scalability', 'nodejs'],
    difficulty: 'medium',
    body: `A cold start is the platform creating an execution environment: download the package, start the runtime, run your initialisation code, then the handler. Subsequent invocations on that environment skip all of it.

What genuinely reduces it: a smaller deployment package, less work at module scope, and a runtime that starts fast. Provisioned concurrency removes it entirely for a paid, pre-warmed pool.

What does not: pinging the function on a timer. It keeps one environment warm while a traffic spike creates many new ones.

Two design points that matter more than the milliseconds:

Code outside the handler runs ONCE per environment, so database clients, SDK clients and config belong there. Creating a connection per invocation is the real performance bug.

But environments are frozen between invocations, so background work started and not awaited may simply stop mid-flight and resume, confusingly, on the next call.

And connection-oriented databases plus high concurrency means a connection pool problem — which is what RDS Proxy exists for.`,
    takeaway: 'Initialise clients outside the handler, keep the package small, and never rely on pinging to stay warm.',
  },

  {
    id: 'sqs-visibility-timeout',
    kind: 'pattern',
    track: 'concepts',
    title: 'The message processed twice',
    tags: ['messaging', 'distributed-systems', 'reliability'],
    difficulty: 'medium',
    body: `SQS does not remove a message when you receive it. It hides it for the VISIBILITY TIMEOUT and waits for you to delete it. Fail to delete in time and it becomes visible again for another consumer.

So the timeout must exceed your worst-case processing time, or slow work is silently duplicated — and the duplicate is often the thing that makes the work slow, so it compounds.

The rest of the checklist:

Delete only after the work is committed, never on receipt.

A redrive policy with maxReceiveCount and a dead-letter queue, or a poison message is retried forever at full cost.

For long work, extend the timeout while you run rather than setting an enormous default that delays every real retry.

With Lambda triggers, report partial batch failures, or one bad record in a batch of ten redelivers all ten.

Standard queues are at-least-once and unordered. FIFO gives ordering per message group id and much lower throughput. Either way the consumer must be idempotent.`,
    takeaway: 'Visibility timeout must exceed processing time. Delete after commit, and always set a dead-letter queue.',
  },

  {
    id: 'aws-messaging-choice',
    kind: 'pattern',
    track: 'concepts',
    title: 'SQS, SNS or EventBridge',
    tags: ['messaging', 'api-design', 'distributed-systems'],
    difficulty: 'medium',
    body: `SQS is a queue: one consumer group pulling work, retries and a dead-letter queue built in. Point to point.

SNS is fan-out: publish once, every subscriber gets a copy, push-based. The classic pattern is SNS to several SQS queues — fan-out with each consumer keeping its own retries and backlog.

EVENTBRIDGE is a router: publish events, and rules match on the event CONTENT to decide where they go, with a schema registry, archive and replay.

How to choose, in one line each: SQS when you are distributing work, SNS when several systems need the same notification, EventBridge when routing should be configuration rather than code.

Say the trade-off too: EventBridge has higher latency than SNS and lower throughput limits, and the content-based routing that makes it flexible also means the routing logic lives somewhere your repository does not.`,
    takeaway: 'SQS distributes work, SNS fans out, EventBridge routes on content. Fan-out to queues keeps retries per consumer.',
  },

  {
    id: 's3-consistency-and-costs',
    kind: 'lesson',
    track: 'concepts',
    title: 'Object storage is not a filesystem',
    tags: ['devops', 'databases', 'scalability'],
    difficulty: 'medium',
    body: `Objects are immutable. There is no append and no partial write: changing one byte uploads the whole object, and "renaming" is a copy plus a delete.

Listing is not a directory read. Keys are flat and prefixes are a convention, so listing a large prefix is paginated and slow, and that is why "just scan the bucket" is a bad plan at scale.

What to know for a design round:

Uploads go DIRECT from the client with a presigned URL. Routing a large file through your API costs bandwidth, memory and a timeout.

Multipart above a few hundred megabytes, with retries per part.

Lifecycle rules move cold objects to cheaper classes automatically, and that is where the savings are.

Egress is the cost that surprises people — storage is cheap, and bandwidth out is not, which is why a CDN in front is both faster and cheaper.

S3 is now strongly consistent for reads after writes, so the old read-after-write caveats no longer apply. Do not repeat them in an interview.`,
    takeaway: 'Presigned direct uploads, multipart for large files, lifecycle rules for cost — and egress is the real bill.',
  },

  {
    id: 'quiz-sqs-duplicate',
    kind: 'quiz',
    track: 'concepts',
    title: 'Two workers, one message',
    tags: ['distributed-systems', 'messaging', 'reliability'],
    difficulty: 'medium',
    body: 'Jobs occasionally run twice. Processing takes about 45 seconds; the SQS visibility timeout is 30. What is happening?',
    choices: [
      'The queue is FIFO and replaying the group',
      'The message becomes visible again before the first worker deletes it',
      'Two consumers are polling the same queue',
      'The dead-letter queue is redriving automatically',
    ],
    answerIdx: 1,
    explanation:
      'Receiving hides a message only for the visibility timeout. At 45 seconds of work against a 30 second timeout, it reappears while the first worker is still going, a second worker picks it up, and both finish. Multiple consumers polling one queue is normal and not the bug. The fix is a timeout above worst-case processing, extending it during long work, and an idempotent consumer.',
    takeaway: 'Visibility timeout below processing time means guaranteed duplicates.',
  },

  /* ══ Real-time at scale ═════════════════════════════════════════════════════ */

  {
    id: 'websocket-scaling',
    kind: 'pattern',
    track: 'concepts',
    title: 'WebSockets across more than one instance',
    tags: ['nodejs', 'api-design', 'scalability'],
    difficulty: 'hard',
    body: `One instance is easy: the socket is in memory, you look it up and write to it.

Two instances and it breaks, because the user you want to reach is connected to the other one. This is the question every real-time design round asks.

The answer is a pub-sub layer between instances — a Redis adapter or a broker. An instance publishes to a room channel, every instance receives it, and each writes only to the sockets it actually holds.

The rest of what a senior answer contains:

Connections are long-lived, so the load balancer needs sticky sessions or a shared session store, and its idle timeout must exceed your heartbeat interval or connections die silently.

Heartbeats both ways, because a half-open TCP connection looks alive from one side indefinitely.

Reconnect with exponential backoff AND jitter — a deploy disconnects everyone at once, and without jitter they all return in the same second.

State on reconnect: the client sends its last received message id and you replay the gap. Without it, a reconnect is a silent hole in the stream.`,
    takeaway: 'Fan out through pub-sub, stick the balancer, heartbeat both ways, and replay the gap on reconnect.',
  },

  {
    id: 'backpressure-realtime',
    kind: 'lesson',
    track: 'concepts',
    title: 'The slow consumer that fills your heap',
    tags: ['nodejs', 'reliability', 'scalability'],
    difficulty: 'hard',
    body: `You are pushing events faster than a client can read them. TCP applies backpressure by not accepting more data — and your process quietly buffers the rest in memory. Enough slow clients and the heap is gone.

In Node this is what stream.write returning false means: stop writing and wait for drain. Ignoring the return value is the single most common cause of a memory leak in a streaming service, and socket.send has the same problem behind a friendlier API.

The strategies, and you should name which you chose:

DROP. For live telemetry, the newest value is the only one that matters. Keep the last, discard the rest.

BUFFER with a bound, then disconnect the client. Honest, and it protects everyone else.

SLOW DOWN the producer. Only possible when you control it.

The one that is never right is unbounded buffering, which converts one slow client into an outage for all of them.

Watch bufferedAmount, or the queue length, per connection.`,
    takeaway: 'Respect write backpressure. Choose drop, bounded buffer, or disconnect — never unbounded.',
  },

  {
    id: 'live-media-basics',
    kind: 'lesson',
    track: 'concepts',
    title: 'Why live video has a latency floor',
    tags: ['networking', 'scalability', 'api-design'],
    difficulty: 'hard',
    body: `Segmented streaming — HLS and DASH — cuts the stream into files and serves them over HTTP. That is why it scales beautifully on a CDN and why latency is measured in seconds: the player must wait for a segment to be written, and usually buffers a few.

WebRTC sends media peer-to-peer over UDP, which is why it is sub-second, and why scaling it needs servers that forward streams rather than a CDN.

So the choice is a trade, not a preference. Broadcast to thousands who can accept several seconds, use segmented streaming. Conversation, where a second of delay ruins the interaction, use WebRTC.

What interviewers probe from there: the ladder of renditions and who transcodes them, how you cap a live stream to a CDN cache lifetime shorter than a segment, and what the fallback is when UDP is blocked by a corporate firewall — which is a TURN relay, and it costs real bandwidth.`,
    takeaway: 'Segments buy CDN scale at seconds of latency; WebRTC buys sub-second at the cost of forwarding servers.',
  },

  /* ══ Identity and access ════════════════════════════════════════════════════ */

  {
    id: 'oauth-flows',
    kind: 'lesson',
    track: 'concepts',
    title: 'OAuth in the three sentences that matter',
    tags: ['security', 'api-design'],
    difficulty: 'medium',
    body: `OAuth 2 is AUTHORISATION — an access token letting an app act on a resource. OIDC sits on top and adds AUTHENTICATION: an id token that says who the user is. Mixing the two up is the most common mistake in this area.

The only flow you should propose today is AUTHORIZATION CODE WITH PKCE, for web and mobile alike. The browser gets a short-lived code, exchanges it for tokens, and PKCE stops a stolen code being redeemed by anyone else. The implicit flow is deprecated.

Client credentials is the machine-to-machine flow, with no user at all — what a service account uses.

Where tokens live is the part that decides your security posture: an httpOnly, SameSite cookie cannot be read by injected JavaScript, while localStorage can. If you say localStorage, you must have an answer for cross-site scripting.

And refresh tokens should rotate, with reuse detection — a refresh token presented twice means it was stolen, and the whole family gets revoked.`,
    takeaway: 'Authorization code with PKCE, tokens in httpOnly cookies, rotating refresh tokens with reuse detection.',
  },

  {
    id: 'rbac-vs-abac',
    kind: 'lesson',
    track: 'concepts',
    title: 'Roles run out, and then what',
    tags: ['security', 'api-design', 'databases'],
    difficulty: 'medium',
    body: `RBAC assigns permissions to roles and roles to users. Simple, auditable, and it covers most products — until the requirement is "a manager can edit only their own team's records", which is not a role, it is a relationship.

ABAC decides from ATTRIBUTES of the user, the resource and the context: department, ownership, time, tenant. It expresses that rule directly and is much harder to audit, because you can no longer answer "who can do this" by reading a list.

The practical answer is both: roles for coarse capability, attribute checks for the row.

Two rules that are what interviewers are actually checking:

Enforce on the SERVER, per request, on the resource being touched. Hiding a button is not authorisation.

Deny by default. A new endpoint with no rule must be unreachable, not public — which is why the check belongs in a middleware or a policy layer rather than in each handler, where it will eventually be forgotten.`,
    takeaway: 'Roles for capability, attributes for the row. Deny by default, enforced server-side on the resource.',
  },

  {
    id: 'multi-tenant-auth',
    kind: 'pattern',
    track: 'concepts',
    title: 'Which tenant is this request for?',
    tags: ['security', 'databases', 'api-design'],
    difficulty: 'hard',
    body: `In a multi-tenant product the most expensive bug available is one query missing its tenant filter. So the tenant must not be something a developer remembers to add.

Where it comes from: the token, never the request body or a header the client controls. A user switching tenants gets a new token, and the server verifies membership when issuing it.

Where it is enforced, in order of how hard it is to bypass:

Row-level security in the database, keyed on a session variable your connection sets. A forgotten WHERE clause returns nothing rather than everything.

A repository layer that cannot construct a query without a tenant scope.

A middleware that puts the tenant in a request context, with a lint rule banning raw queries.

And test it explicitly: a test that fetches another tenant's id and asserts a 404 is worth more than any amount of review. Note 404, not 403 — telling an attacker the record exists is itself a leak.`,
    takeaway: 'Tenant comes from the token and is enforced in the database or the repository. Cross-tenant reads return 404.',
  },

  {
    id: 'quiz-token-storage',
    kind: 'quiz',
    track: 'concepts',
    title: 'Where the access token lives',
    tags: ['security', 'api-design'],
    difficulty: 'medium',
    body: 'A single-page app stores its access token in localStorage. What is the concrete risk, and what is the usual answer?',
    choices: [
      'Cross-site request forgery; add a CSRF token',
      'Any injected script can read it; use an httpOnly cookie instead',
      'It expires on refresh; use sessionStorage',
      'It is sent to every domain; restrict with CORS',
    ],
    answerIdx: 1,
    explanation:
      'localStorage is readable by any JavaScript on the page, so one cross-site scripting hole — including one in a dependency — exfiltrates the token. An httpOnly cookie cannot be read by script at all. It does reintroduce CSRF, which SameSite plus a token handles, and that trade is the point: the cookie failure mode has a standard mitigation while the localStorage one does not.',
    takeaway: 'localStorage is readable by any script. httpOnly cookies plus SameSite is the trade worth making.',
  },

  /* ══ Databases, deeper ══════════════════════════════════════════════════════ */

  {
    id: 'postgres-mvcc-and-vacuum',
    kind: 'lesson',
    track: 'concepts',
    title: 'Why deleting rows does not free space',
    tags: ['databases', 'postgres'],
    difficulty: 'hard',
    body: `Postgres never updates a row in place. An UPDATE writes a new version and marks the old one dead; a DELETE only marks it dead. That is MVCC, and it is what lets readers never block writers.

Dead rows are reclaimed by VACUUM, which makes the space reusable by the table — not returned to the operating system. That needs VACUUM FULL, which takes an exclusive lock and rewrites the table.

The failures this produces, both common:

BLOAT. A table churned by frequent updates grows far beyond its live row count, and every sequential scan reads the dead weight.

A LONG-RUNNING TRANSACTION blocks cleanup, because its snapshot might still need those old versions. One forgotten idle-in-transaction connection can bloat a busy table for hours.

Monitor n_dead_tup and the age of the oldest transaction. And if an UPDATE can change an indexed column, every index must be updated too — which is why touching an indexed column in a hot loop is far dearer than it looks.`,
    takeaway: 'Updates write new versions; VACUUM reclaims them. A long-open transaction blocks that and causes bloat.',
  },

  {
    id: 'connection-pooling',
    kind: 'lesson',
    track: 'concepts',
    title: 'Why 500 connections is slower than 50',
    tags: ['databases', 'postgres', 'scalability'],
    difficulty: 'medium',
    body: `A Postgres connection is a backend process with its own memory. They are expensive, and past the point where active connections exceed the cores available, adding more makes everything slower — the same work, more context switching and lock contention.

So the pool is a queue, deliberately. A small pool with requests waiting beats a large pool with the database thrashing.

Where this bites in practice:

Every instance has its own pool. Twenty pods times a pool of twenty is four hundred connections to one database, and nobody wrote that number down.

Serverless makes it worse: concurrency is elastic and each environment wants a connection. That is what RDS Proxy and pgbouncer exist for.

Transaction-mode pooling multiplexes many clients onto few connections, at the cost of session state — prepared statements, session variables and advisory locks do not survive. Tools that assume them break, and knowing why is a strong signal.

Size it from the database's capacity, not from your traffic.`,
    takeaway: 'Pools protect the database. Size from its cores, count every instance, and use a proxy under serverless.',
  },

  {
    id: 'postgres-vs-mongo',
    kind: 'lesson',
    track: 'concepts',
    title: 'Document or relational, decided honestly',
    tags: ['databases', 'mongodb'],
    difficulty: 'medium',
    body: `The old answer — "Mongo scales, Postgres does not" — has not been true for years, and giving it marks you out. Both shard, both do JSON, both have transactions.

The real question is your ACCESS PATTERN.

A document store wins when the aggregate you read is the aggregate you write: one document, fetched whole, no joins, and a shape that varies per record. Embedding is the win, and it is genuine.

Relational wins the moment the same data must be queried from several directions, because that is what joins and secondary indexes are for. Without them you denormalise, and then you own the consistency of every copy by hand.

The practical trap is the 16MB document limit and unbounded arrays — an array that grows per event will eventually stop the document being writable, and moving that to its own collection is a migration under load.

Say what you would pick and what would change your mind. Postgres with jsonb covers both cases well enough that "one database" is often the senior answer.`,
    takeaway: 'Embed when the read shape equals the write shape. Query from several directions means relational.',
  },

  {
    id: 'idempotent-consumer-pattern',
    kind: 'pattern',
    track: 'concepts',
    title: 'Making a consumer safe to run twice',
    tags: ['distributed-systems', 'databases', 'messaging'],
    difficulty: 'hard',
    body: `Every queue you will use is at-least-once, so this is not optional.

Cheapest first:

NATURALLY IDEMPOTENT work. Setting a status to shipped is safe repeated; incrementing a counter is not. Reshape the operation if you can.

UPSERT keyed by the event id. One statement, no read-then-write race.

A PROCESSED TABLE holding the event id with a unique constraint, written in the SAME transaction as the effect. On a duplicate the insert fails and you ack without doing the work.

Not any of these: checking "have I seen this" and then doing the work in two steps. Two consumers run that concurrently and both see nothing.

The detail that decides correctness is the transaction boundary. If the effect and the marker are not committed together, a crash between them gives you either duplicated work or a lost event — pick a database where they can be one commit, or accept and design for the gap.`,
    takeaway: 'Record the event id in the same transaction as the effect. Check-then-act is a race, not a guard.',
  },

  /* ══ Frontend at senior level ═══════════════════════════════════════════════ */

  {
    id: 'rendering-strategies',
    kind: 'lesson',
    track: 'concepts',
    title: 'CSR, SSR, SSG, ISR — chosen by the data',
    tags: ['react', 'javascript', 'caching'],
    difficulty: 'medium',
    body: `Pick by how the DATA behaves, not by what is fashionable.

STATIC at build time, for content that changes on a deploy. A file on a CDN. Nothing is faster or cheaper.

INCREMENTAL regeneration for content that changes on its own schedule: serve the cached page, rebuild it in the background after a revalidation window. This is the right answer far more often than full SSR.

SERVER-RENDERED per request for pages that are personalised or must be fresh at the moment of the request, and where the first paint matters — SEO, slow devices, link previews.

CLIENT-RENDERED for an authenticated app behind a login, where the shell is cached and the data is fetched.

The costs to name: SSR moves load to your servers and makes every page a request you must cache deliberately; hydration means the user can see an interface before it responds, which is worse than a spinner if it lasts.`,
    takeaway: 'Static by default, incremental for scheduled change, server-render only what must be fresh per request.',
  },

  {
    id: 'frontend-performance-budget',
    kind: 'pattern',
    track: 'concepts',
    title: 'What to fix when the page is slow',
    tags: ['react', 'javascript'],
    difficulty: 'medium',
    body: `Answer with the metric that matches the complaint, then the fix. The three that matter map to three distinct problems:

SLOW TO SHOW ANYTHING — render-blocking resources and payload size. Split the bundle by route, defer what is not needed for the first paint, and preload the font and hero image.

SLOW TO BECOME USABLE — too much JavaScript executing. Ship less of it. Code splitting and lazy loading below the fold, not a faster framework.

JUMPS WHILE LOADING — layout shift. Reserve space for images and ads with explicit dimensions, and never inject content above what is already rendered.

For React specifically: re-render problems are usually a new object or callback identity being passed down, or context holding a value that changes often. Measure with the profiler before memoising — memoisation has its own cost and applied blindly it makes things slower and harder to read.

And virtualise long lists. A thousand rows in the DOM is a design mistake, not a rendering one.`,
    takeaway: 'Payload for first paint, JavaScript volume for interactivity, reserved space for shift. Profile before memoising.',
  },

  {
    id: 'microfrontend-tradeoff',
    kind: 'lesson',
    track: 'concepts',
    title: 'Micro-frontends buy autonomy and cost coherence',
    tags: ['react', 'javascript'],
    difficulty: 'hard',
    body: `They solve an ORGANISATIONAL problem: several teams shipping to one page on their own schedules without a coordinated release. If you do not have that problem, you do not want the architecture.

What you pay:

Duplicate dependencies. Two Reacts on a page is both a size and a correctness problem — context and hooks do not cross instances. Module federation shares them, at the cost of version coupling between teams, which is some of the autonomy back.

Visual drift, unless the design system is a shared, versioned package with real discipline.

Harder debugging: a bug is now in one of several bundles built by different pipelines, and the source maps have to be right.

Cross-app state needs an explicit contract — events or a shared store — because imports across boundaries defeat the point.

The honest alternative is a monorepo with strong module boundaries and one deploy, which gets most of the autonomy without a distributed frontend. Saying that is a senior answer.`,
    takeaway: 'Micro-frontends solve team autonomy and cost bundle size, coherence and debuggability. Consider a monorepo first.',
  },

  {
    id: 'optimistic-ui',
    kind: 'pattern',
    track: 'concepts',
    title: 'Updating the screen before the server agrees',
    tags: ['react', 'api-design'],
    difficulty: 'medium',
    body: `You see: a like button, a drag reorder, a message send — where waiting for a round trip makes the interface feel broken.

Apply the change locally, fire the request, and reconcile.

The three things that make it correct rather than merely fast:

A ROLLBACK path. Keep the previous state and restore it on failure, with a visible, non-modal message. Silently reverting is worse than a spinner.

IDEMPOTENCY on the server, because the retry that follows a timeout must not double the effect.

ORDERING. Two quick edits can complete out of order, so the later response overwrites the newer state. Version each mutation and ignore stale responses.

When NOT to do it: anything with money, anything irreversible, anything where the server may legitimately refuse for a reason the client cannot predict. Showing a payment as complete and taking it back is worse than a two second wait.`,
    takeaway: 'Optimistic updates need rollback, idempotency and ordering. Never for money or anything irreversible.',
  },

  /* ══ Node in production ═════════════════════════════════════════════════════ */

  {
    id: 'node-memory-leak-hunt',
    kind: 'pattern',
    track: 'concepts',
    title: 'Finding a leak in a Node service',
    tags: ['nodejs', 'javascript', 'reliability'],
    difficulty: 'hard',
    body: `Rising memory is not a leak until you have ruled out a heap that is simply allowed to grow. Confirm first: is old-space rising ACROSS collections, and does it never come down?

Then take two heap snapshots, minutes apart under load, and compare. Work the retainer path of the biggest growing type — that path names the object holding your garbage.

The four causes that account for most of them:

Listeners added per request to a long-lived emitter, never removed. The max-listeners warning is the gift here.

An unbounded cache or Map keyed by something with unlimited cardinality. A cache with no eviction is a leak with a plan.

Closures captured by something long-lived: a timer, a promise that never settles, a global array.

Streams not consumed or destroyed, so their buffers stay reachable.

Then measure RSS separately from the heap — native buffers and fragmentation live outside it, and a growing RSS with a flat heap is a different investigation.`,
    takeaway: 'Two snapshots under load, follow the retainer path. Suspect listeners, unbounded caches, closures and streams.',
  },

  {
    id: 'node-error-handling',
    kind: 'lesson',
    track: 'concepts',
    title: 'The unhandled rejection that takes the process down',
    tags: ['nodejs', 'javascript', 'reliability'],
    difficulty: 'medium',
    body: `Modern Node terminates the process on an unhandled promise rejection by default. That is correct — an unknown broken state is worse than a restart — but only if you have a process manager, and only if shutdown is graceful.

The rules that keep a service honest:

An OPERATIONAL error — a failed request, a validation failure, a dead dependency — is expected and handled where it happens, with a status code.

A PROGRAMMER error — undefined is not a function — is a bug. Log it with context, let the process die, and restart. Trying to continue is how a corrupted service serves wrong answers for an hour.

Do not swallow. A bare catch that logs and carries on converts a crash into a mystery.

Async stack traces are the first thing you lose across an await boundary and a queue hop, so attach a correlation id at the edge and carry it — through logs, through the queue, through the downstream call. Without it, a distributed failure is unreadable.`,
    takeaway: 'Handle operational errors; crash on programmer errors and restart. Carry a correlation id everywhere.',
  },

  {
    id: 'node-worker-threads',
    kind: 'lesson',
    track: 'concepts',
    title: 'Threads, processes, and the libuv pool',
    tags: ['nodejs', 'javascript', 'scalability'],
    difficulty: 'hard',
    body: `Three different mechanisms, routinely confused:

CLUSTER and multiple processes give you real parallelism across cores with full isolation. Each has its own memory, so state must be external. This is what a container orchestrator does for you by running replicas.

WORKER THREADS share a process and can transfer memory cheaply, which suits CPU work on large buffers — image processing, parsing, compression. They are not for I/O.

The LIBUV THREADPOOL is neither; it serves file system calls, DNS lookups and some crypto, and it defaults to four threads. Saturate it and unrelated file reads queue behind each other for no visible reason. UV_THREADPOOL_SIZE raises it.

Network I/O uses none of these — it is the event loop and the kernel, which is why Node handles thousands of sockets on one thread.

The senior framing: under Kubernetes, prefer more replicas to in-process clustering. One process per container keeps signals, limits and metrics simple.`,
    takeaway: 'Workers for CPU, replicas for scale, and remember the four-thread libuv pool behind file and DNS work.',
  },

  /* ══ Senior interviewing ════════════════════════════════════════════════════ */

  {
    id: 'senior-scope-signals',
    kind: 'lesson',
    track: 'behavioural',
    title: 'What "senior" is actually measured by',
    tags: ['reasoning', 'structure', 'professionalism'],
    difficulty: 'medium',
    body: `Not years, and not the hardest thing you have built. Interviewers are checking four things, and you should make each of them visible with a specific example:

SCOPE. You own an outcome, not a ticket. "I owned the caching layer" beats "I implemented caching".

JUDGEMENT UNDER CONSTRAINT. A decision you made with incomplete information, the trade you accepted, and how it turned out. Including when it turned out badly.

MULTIPLIER EFFECT. Review, mentoring, documentation, a standard you set that outlived your involvement.

RISK SENSE. You saw the failure before it happened and said so. Rollbacks, migrations, blast radius, what you refused to ship on a Friday.

The single strongest thing you can do in a senior loop is name the trade-off in every answer. Mid-level answers describe what was built. Senior answers describe what was given up and why that was the right price.`,
    takeaway: 'Scope, judgement, multiplier effect, risk sense. Name the trade-off in every answer.',
  },

  {
    id: 'senior-disagree-with-the-plan',
    kind: 'lesson',
    track: 'behavioural',
    title: 'Pushing back without being difficult',
    tags: ['listening', 'professionalism', 'confidence'],
    difficulty: 'medium',
    body: `"Tell me about a time you disagreed with a technical direction" is a senior staple, and it is scored on METHOD rather than on who was right.

The shape that works:

State their position at its strongest, honestly. A candidate who can only argue their own side has not actually understood the decision.

Say what you did to make the disagreement resolvable — a spike, a benchmark, a prototype, a written trade-off document. Moving it from opinion to evidence is the senior move.

Name the cost of being wrong in each direction, which is usually what settles it.

Then commit. Either it went your way and you did not make a thing of it, or it did not and you implemented it properly. "I disagree and commit" is a real answer and interviewers know it.

The fail: a story where you were right, everyone else was foolish, and nothing was learned.`,
    takeaway: 'Argue their side fairly, convert opinion to evidence, price both mistakes, then commit either way.',
  },

  {
    id: 'incident-story-shape',
    kind: 'lesson',
    track: 'behavioural',
    title: 'The production incident story',
    tags: ['structure', 'composure', 'reasoning'],
    difficulty: 'medium',
    body: `Have one rehearsed. It is asked in almost every senior loop, and it is the answer where structure shows most.

IMPACT first, in one line. Who was affected, for how long. Not the architecture.

DETECTION. How you found out — and if it was a customer, say so, because the follow-up is what you changed about that.

MITIGATION before diagnosis. Senior engineers stop the bleeding first: roll back, fail over, shed load, disable the flag. Explaining that you restored service before you understood the cause is a strong signal, not an admission.

CAUSE, with the real one rather than the trigger. The deploy was the trigger; the missing constraint was the cause.

PREVENTION, and this is the whole point of the question. One change that makes the CLASS of failure impossible, not a promise to be careful. A test, an alert, a limit, a type.

And no blame. The incident had a systemic cause or your post-mortem was not finished.`,
    takeaway: 'Impact, detection, mitigate-then-diagnose, root cause, one systemic prevention. Never name a person.',
  },

  /* ══ Your own rounds ════════════════════════════════════════════════════════
     Cards on the `experience` track prompt for material only the reader has.
     They deliberately ask rather than teach: an interviewer's follow-ups go
     straight past a story that was never prepared with numbers attached. */

  {
    id: 'exp-throughput-story',
    kind: 'lesson',
    track: 'experience',
    title: 'Have the numbers for your biggest system',
    tags: ['reasoning', 'confidence'],
    difficulty: 'medium',
    body: `Pick the highest-traffic system you have owned and write down the numbers before an interviewer asks for them. Vague scale claims are the fastest way to lose credibility in a senior loop.

What you need to be able to say without hesitating:

Requests per second at peak, and the read-to-write ratio.
The latency you held, at the ninety-ninth percentile rather than the mean.
Data size, and how fast it grew.
Instance count, and what the bottleneck actually was.
What it cost, if you know.

Then one sentence on the thing you changed that moved one of those numbers, with the before and after.

If you do not know a number, say you do not and give the order of magnitude. "Low hundreds per second, peaking maybe three times that" is a credible answer. "It was very high traffic" is not, and every follow-up after it gets harder.`,
    takeaway: 'Peak throughput, p99 latency, data size, instance count — and one change with a before and after.',
  },

  {
    id: 'exp-hardest-bug',
    kind: 'lesson',
    track: 'experience',
    title: 'Your hardest debugging story, told well',
    tags: ['reasoning', 'structure'],
    difficulty: 'medium',
    body: `The question is really "how do you think when you do not know the answer", so the story is about METHOD, not about how obscure the bug was.

Prepare one where you can say:

What the symptom was, and why the obvious explanation was wrong. The wrong first hypothesis is worth including — it shows the loop.

How you narrowed it. What you measured, what you ruled out, and the point where the search space halved.

The moment it became reproducible, because that is usually the real turning point.

The fix, and separately the thing that made the bug POSSIBLE. Those are different, and the second one is where senior shows.

What now prevents it, or at least makes it visible in minutes rather than days.

A memory leak, a cache inconsistency, a reconnect that silently stopped reconnecting — the ones that took days are the ones worth telling, because they have a real narrowing story in them.`,
    takeaway: 'Symptom, wrong first guess, how you narrowed it, reproduction, cause versus trigger, what prevents it now.',
  },

  {
    id: 'exp-architecture-decision',
    kind: 'lesson',
    track: 'experience',
    title: 'One decision you would defend, one you would not',
    tags: ['humility', 'reasoning'],
    difficulty: 'hard',
    body: `Senior loops probe architectural judgement through your own history, so prepare both halves.

THE ONE YOU WOULD DEFEND: the constraint you were under, the options you compared, why you chose as you did, and what it would have cost to be wrong. The options matter more than the choice — a decision with no rejected alternatives reads as a default rather than a decision.

THE ONE YOU WOULD NOT: something you would do differently now, with the reason you could not have known it then, and what you would look for earlier. This answer is a trap only if you pick something that reveals carelessness rather than judgement.

Good material: a service boundary you drew in the wrong place, a technology chosen for the team you had rather than the problem, a piece of consistency you bought and did not need.

Avoid a decision that was not yours, and avoid one with no consequence — "we used tabs" is not an architecture story.`,
    takeaway: 'Prepare one decision with its rejected alternatives, and one you would now make differently, with the reason.',
  },

  {
    id: 'exp-migration-story',
    kind: 'lesson',
    track: 'experience',
    title: 'The migration you did without downtime',
    tags: ['structure', 'reasoning'],
    difficulty: 'hard',
    body: `Anything you have moved — a database, a queue, an auth provider, a major version — is prime senior material, because a migration is where judgement and risk management are visible.

The frame that reads well:

Why it had to move, in business terms rather than technical distaste.

The strategy: expand and contract, dual write, shadow read, gradual cutover by percentage or tenant. Name the one you used.

How you verified equivalence BEFORE switching. Comparing old and new outputs on real traffic is the answer interviewers want, and it is what separates a plan from a hope.

The rollback point, and how long you kept it open.

What broke anyway. There is always something, and the story is better with it.

Say the duration honestly too. A three-month migration that nobody noticed is a better story than a weekend cutover that worked, and interviewers know which one is harder.`,
    takeaway: 'Expand-contract, dual write, verify equivalence on real traffic, keep the rollback open — and say what broke.',
  },
];
