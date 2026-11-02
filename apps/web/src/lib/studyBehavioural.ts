import type { ConceptGroup } from './study';

/**
 * The behavioural guide. The playbook's Behavioural tab says how to run the
 * answer; this says what is being scored and how to prepare the stories the
 * answers are made of, which is the work that has to happen days before.
 */
export const BEHAVIOURAL_GROUPS: ConceptGroup[] = [
  {
    id: 'beh-scored',
    title: 'What is being scored',
    lead: 'A behavioural round is not checking that your stories are impressive. It is collecting evidence of a few specific behaviours, and every question is aimed at one or two of them.',
    concepts: [
      {
        id: 'beh-signals',
        title: 'What the round is listening for',
        core: true,
        what: 'Evidence of how you behave at work, judged from what you DID in a real past situation — never from what you say you would do.',
        does: 'Most rubrics score a handful of signals: ownership (did you drive it, or watch it), impact (did it matter, measurably), judgment (how you chose between options), collaboration (how you worked with and through people), and growth (what you learned and changed afterwards). Past behaviour is asked for because it predicts future behaviour far better than a hypothetical, which anyone can answer ideally.',
        reachWhen: ['Before preparing any story — decide which signal it proves.', 'Any question starting "tell me about a time".'],
        tradeoffs: [
          'An impressive project in which you made no decision scores low.',
          'Answering "I would…" or "I usually…" gives them no evidence at all.',
        ],
        say: 'Let me give you a specific example rather than how I generally work.',
        check: {
          q: 'Why does a behavioural round ask about the past rather than "what would you do"?',
          a: 'A real past situation is harder to fake and predicts future behaviour better than a hypothetical, which anyone can answer ideally.',
        },
        related: ['beh-values', 'beh-star'],
      },
      {
        id: 'beh-values',
        title: 'Company values are the question list',
        what: 'Many companies publish the behaviours they hire for — Amazon\'s Leadership Principles are the best known — and their questions are those values turned into prompts.',
        does: 'Read the company\'s values before the round and map each of your stories to the one or two it shows. "Tell me about a time you disagreed and then committed" or "a time you went beyond your role" are values phrased as questions. Knowing the list tells you which stories to have ready.',
        reachWhen: ['Preparing for one specific company.', 'A question that sounds oddly specific — it is probably a value.'],
        tradeoffs: [
          'Reciting the value names sounds rehearsed. Show the behaviour; never name the principle.',
          'Forcing a story onto a value it does not fit is worse than picking a plainer story that does.',
        ],
        say: 'What I cared about there was the customer outcome, not just closing the ticket — so I <action>.',
        check: {
          q: 'How do you use a company\'s published values when preparing?',
          a: 'Map every story in your bank to the values it demonstrates, so for any value-shaped question you already know which story to tell.',
        },
        related: ['beh-story-bank'],
      },
    ],
  },

  {
    id: 'beh-prepare',
    title: 'Preparing your stories',
    lead: 'The round is won or lost in the week before it. Nobody can invent a good story in the eight seconds after the question.',
    concepts: [
      {
        id: 'beh-story-bank',
        title: 'The story bank',
        core: true,
        what: 'Six to eight real stories, prepared in advance, each able to answer several different questions.',
        does: 'Most behavioural questions are variations on about a dozen themes: conflict, failure, leading without authority, ambiguity, a tight deadline, disagreeing with a manager, helping a struggling teammate, a large impact, a hard technical call, and feedback given or received. Write each story once in STAR form. Then make a grid — stories across, themes down — and tick which story covers which theme. Every theme should have at least two stories.',
        reachWhen: ['A week before the round.', 'After every round — add the question you had no story for.'],
        tradeoffs: [
          'Stories more than three or four years old read as stale. Prefer recent ones.',
          'Memorised word for word, a story sounds scripted. Memorise the beats and the numbers, not the sentences.',
        ],
        numbers: 'Six to eight stories, each covering two or three themes, gives every common theme at least two candidates.',
        say: 'Two examples come to mind — let me take the more recent one.',
        check: {
          q: 'Why have at least two stories for every theme?',
          a: 'A loop can ask related questions in different rounds, and reusing one story looks thin. A second story also lets you pick the closer fit to the exact wording.',
        },
        related: ['beh-star', 'beh-choosing'],
      },
      {
        id: 'beh-star',
        title: 'STAR, and where the time goes',
        core: true,
        what: 'Situation, Task, Action, Result — an order that keeps a story short and puts the weight where it is scored.',
        does: 'Situation and task together: two or three sentences of setup. Action: what YOU did, step by step, including the decision you made and the alternative you turned down — the bulk of the answer. Result: what happened, with a number, then one sentence on what you learned or would change.',
        reachWhen: ['Every "tell me about a time" question.'],
        tradeoffs: [
          'A long situation is the most common failure — the listener is waiting for you to start.',
          'Skipping the learning sentence throws away the growth signal.',
        ],
        numbers: 'Roughly 20% situation and task, 60% action, 20% result and reflection. Two to three minutes in total.',
        say: 'The situation was <one sentence>. My job was <one sentence>. So I did three things.',
        check: {
          q: 'Which part of STAR carries most of the score, and roughly what share of the answer should it get?',
          a: 'The action — about sixty percent — because that is where your decisions and behaviour are.',
        },
        related: ['beh-i-not-we', 'beh-quantify'],
      },
      {
        id: 'beh-choosing',
        title: 'Picking the right story',
        what: 'Choosing, in a few seconds, the story that best fits the exact question asked.',
        does: 'A good story is recent, had real stakes, contains a decision you made, ends with a measurable result, and has something you would do differently. Match the question\'s key word: "disagreed" needs a real disagreement, "failed" needs a real failure. If nothing fits exactly, take the closest and say in one sentence how it maps.',
        reachWhen: ['The pause straight after the question.'],
        tradeoffs: [
          'A big launch where you were a bystander is a worse story than a small project you drove.',
          'Changing stories halfway through, because a better one came to mind, reads as disorganised. Finish the one you started.',
        ],
        say: 'Let me take a moment to pick the best example.',
        check: {
          q: 'A small project you led, or a large launch you contributed a minor part to — which do you tell?',
          a: 'The one you led. The score is for your decisions and actions, not for the size of the project.',
        },
        related: ['beh-story-bank'],
      },
    ],
  },

  {
    id: 'beh-telling',
    title: 'Telling it well',
    lead: 'The same story can score a two or a five depending on whose decisions it makes visible and whether it survives the second question.',
    concepts: [
      {
        id: 'beh-i-not-we',
        title: '"I", not "we"',
        core: true,
        what: 'Making your own part explicit, so the interviewer can credit you with something.',
        does: 'Credit the team once, then switch to what you did. Interviewers listen for whose decision each step was; a story told entirely in "we" leaves them nothing to credit you with, however big the project.',
        reachWhen: ['Every action section.', 'The follow-up "what was your part?"'],
        tradeoffs: [
          'Overcorrecting into claiming the team\'s work. Say what others did, then what you did.',
        ],
        say: 'The team built the pipeline; my part was the rollout plan and the call to ship it behind a flag.',
        check: {
          q: 'How do you show teamwork without hiding your own contribution?',
          a: 'Name the team\'s part in one line, then describe your own actions and decisions with "I". Collaboration shows in how you worked with them, not in the pronoun.',
        },
        related: ['beh-star'],
      },
      {
        id: 'beh-quantify',
        title: 'Results with numbers',
        core: true,
        what: 'Ending every story with a measurable outcome, and how you knew.',
        does: 'Latency, error rate, revenue, time saved, tickets reduced, adoption, people affected. Without exact figures, give an honest approximation and its source: "roughly halved — from about forty tickets a week to under twenty". When the result was qualitative, give the concrete evidence: who said what, and what changed afterwards.',
        reachWhen: ['The result of every story.'],
        tradeoffs: [
          'Invented precision gets probed, and collapses.',
          'A number with no baseline — "improved it by 30%" — is weaker than a before and an after.',
        ],
        say: 'The result was that p99 latency fell from about 1.4 seconds to under 400 milliseconds, measured on our dashboard over the following month.',
        check: {
          q: 'Your result was "the team was happier". How do you make it concrete?',
          a: 'Give the evidence: retention, survey scores, fewer escalations, a specific piece of feedback, or what changed in how the team worked afterwards.',
        },
        related: ['beh-star'],
      },
      {
        id: 'beh-followups',
        title: 'Surviving the follow-up',
        what: 'The second and third questions after your story, which test whether it holds up.',
        does: 'Typical probes: what would you do differently, what did the other person say, why that option over another, what was the hardest part, what did your manager think, what happened next. Each asks for more depth on the SAME story. Prepare one level more detail than you plan to say.',
        reachWhen: ['After every story.'],
        tradeoffs: [
          'Details that change under probing destroy credibility. Tell it truthfully the first time.',
          'Answering a probe with a new story dodges it. Go deeper into the one you told.',
        ],
        say: 'Good question — the alternative I considered was <...>, and I did not choose it because <...>.',
        check: {
          q: 'Name three common follow-up probes.',
          a: 'Any three of: what would you do differently, why that option, what was hardest, what did the other person or your manager think, what did you learn, what happened next.',
        },
        related: ['beh-choosing'],
      },
    ],
  },

  {
    id: 'beh-themes',
    title: 'The hard themes',
    lead: 'The questions people dread, and what each one is actually checking. Have two stories ready for every one.',
    concepts: [
      {
        id: 'beh-conflict',
        title: 'Conflict and disagreement',
        what: 'Stories where you disagreed with a colleague, a manager or another team.',
        does: 'What is checked: that you disagree on substance rather than personality, that you understood the other side, that you used evidence rather than authority, and that the relationship survived. "Disagree and commit" — accepting a decision you argued against and then working to make it succeed — is a strong ending.',
        reachWhen: ['"Tell me about a conflict", "a disagreement with your manager", "a time you pushed back".'],
        tradeoffs: [
          'A story in which the other person is the villain reads as poor collaboration.',
          'A story with no real disagreement in it does not answer the question.',
        ],
        say: 'We disagreed about <the technical question>. Their concern was <...>, so I proposed we settle it with <a test, a measurement, a small trial>.',
        check: {
          q: 'Why is "disagree and commit" a strong ending to a conflict story?',
          a: 'It shows you argued with evidence, accepted the decision when it went the other way, and still worked to make it succeed — judgment and team play together.',
        },
        related: ['beh-leadership'],
      },
      {
        id: 'beh-failure',
        title: 'Failure and mistakes',
        what: 'Stories where something went wrong and it was at least partly your fault.',
        does: 'What is checked: ownership, honesty, and what you changed. Own it in the first sentence, state the impact plainly, describe the fix, and end with the change in how you work that stops it happening again.',
        reachWhen: ['"Tell me about a failure", "a mistake you made", "a project that did not go well".'],
        tradeoffs: [
          'A disguised strength — "I cared too much" — reads as evasive.',
          'A catastrophic failure with no learning is a red flag. Pick a real but recoverable one.',
          'A failure that was really someone else\'s does not answer the question.',
        ],
        say: 'That one was on me: I <mistake>, and the impact was <...>. Here is how I fixed it, and what I changed afterwards.',
        check: {
          q: 'What are the four beats of a failure story?',
          a: 'Own it, state the impact, the fix, and the lasting change in how you work.',
        },
        related: ['beh-weakness'],
      },
      {
        id: 'beh-weakness',
        title: 'Your weakness',
        what: 'The direct question about something you are working on.',
        does: 'Pick something real, credible for the role but not fatal to it. Give a concrete moment it cost you, what you are doing about it, and where it stands now. The question is checking self-awareness, so the evidence of working on it matters more than the weakness itself.',
        reachWhen: ['"What is your biggest weakness?", "What feedback have you had?", "What are you working on?"'],
        tradeoffs: [
          'Clichés such as "perfectionism" score as no answer.',
          'A weakness central to the job — "I struggle to write code" — disqualifies.',
        ],
        say: 'Something I have been actively working on is <...>. It showed up when <...>, so now I <habit>, and the most recent sign of progress is <...>.',
        check: {
          q: 'Why is "I am a perfectionist" a weak answer?',
          a: 'It is a cliché that avoids self-awareness, and it offers no concrete example or improvement to evaluate.',
        },
        related: ['beh-failure'],
      },
      {
        id: 'beh-leadership',
        title: 'Leading without authority',
        what: 'Getting people to change direction when they do not report to you.',
        does: 'The behaviours checked: noticing what needed to change, owning it without being asked, understanding what the others cared about, and persuading with evidence — data, a prototype, a small low-risk trial — rather than with position.',
        reachWhen: ['"Tell me about a time you led…", "influenced another team", "went beyond your role".'],
        tradeoffs: [
          'A leadership story told as "I told them what to do" misses the point entirely.',
          'Leaving out the people who disagreed makes it sound easy, and easy is not evidence.',
        ],
        say: 'Nobody owned it, so I picked it up. The other team cared about <...>, so I showed them <evidence>.',
        check: {
          q: 'What persuades people who do not report to you?',
          a: 'Evidence, and alignment with what they care about — data, a prototype, a small low-risk trial — rather than position.',
        },
        related: ['beh-conflict', 'beh-ambiguity'],
      },
      {
        id: 'beh-ambiguity',
        title: 'Ambiguity and prioritisation',
        what: 'Stories about acting without full information, or choosing what not to do.',
        does: 'Show how you reduced the uncertainty — who you asked, what you measured — the trade-off you made, how you communicated it, and how you adjusted as you learned more.',
        reachWhen: ['"A time requirements were unclear", "competing priorities", "a tight deadline".'],
        tradeoffs: [
          '"I just worked harder" misses the judgment signal the question is after.',
          'A decision nobody was told about reads as going rogue. Say who you told, and when.',
        ],
        say: 'We could not do both by the deadline, so I chose <...>, told <stakeholder> what we were dropping and why, and <outcome>.',
        check: {
          q: 'In a tight-deadline story, what is the interviewer looking for besides the deadline being met?',
          a: 'The trade-off you made, how you decided it, and how you communicated it — judgment, not just effort.',
        },
        related: ['beh-leadership'],
      },
    ],
  },
];
