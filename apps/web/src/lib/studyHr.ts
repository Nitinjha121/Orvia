import type { ConceptGroup } from './study';

/**
 * HR and compensation guide tailored for compensation structures (CTC, fixed vs
 * variable components, notice periods, and verification standards). Focuses on
 * negotiation strategy without anchoring discussions prematurely to current pay.
 */
export const HR_GROUPS: ConceptGroup[] = [
  {
    id: 'hr-numbers',
    title: 'Know the numbers',
    lead: 'Before any call: what an offer is actually made of, how the company decides it, and what the market pays. Every argument later rests on these.',
    concepts: [
      {
        id: 'ctc-breakdown',
        title: 'What is inside a CTC',
        core: true,
        what: 'CTC is what you cost the company in a year, not what you are paid — it bundles fixed pay with parts that may never reach you.',
        does: 'The usual parts: fixed base; variable or performance bonus, often paid at less than target; a joining bonus, usually one-time with a clawback if you leave within a year; stock (RSUs, or ESOPs at a startup) vesting over several years at whatever the shares are worth then; and employer PF, gratuity and insurance. Two "70 LPA" offers can differ by twenty lakh in fixed pay. Compare fixed to fixed first, then guaranteed cash in year one, then the four-year total.',
        reachWhen: ['Reading any offer.', 'Comparing two offers.', 'Stating your own CTC — know your fixed and variable separately.'],
        tradeoffs: [
          'Target variable is a maybe. Ask what percentage of target was actually paid last year.',
          'Joining bonuses usually come with a clawback if you leave inside twelve months.',
          'Stock vesting is often uneven or back-loaded, so year one can hold far less than a quarter of the grant.',
          'Startup ESOPs may be worth nothing; value them at zero when comparing, and treat any upside as a bonus.',
        ],
        numbers: 'Ask for three numbers on every offer: fixed per year, guaranteed cash in year one, and the four-year total with stock at today\'s price.',
        say: 'Could you break the seventy down for me — fixed, variable, joining bonus and stock — and share the vesting schedule?',
        check: {
          q: 'Both offers are "70 LPA". A is 60 fixed plus 10 target variable. B is 45 fixed plus a 100 lakh RSU grant vesting 10%, 20%, 30%, 40% over four years. What is guaranteed cash in year one for each?',
          a: 'A: 60 guaranteed, plus up to 10 if the variable pays in full. B: 45 cash plus 10 lakh of stock — 55 at most, only 45 of it guaranteed cash. Same headline, very different first year.',
        },
        related: ['bands-levels', 'beyond-base'],
      },
      {
        id: 'bands-levels',
        title: 'Bands and levels decide the offer',
        core: true,
        what: 'Most product companies and MNCs pay by a band attached to the LEVEL they hire you at — not as a percentage on top of your current pay.',
        does: 'When a role "pays 70", the band for its level contains 70. Your offer is placed inside that band using your interview performance, your experience and your leverage. That makes the level the biggest lever you have: one level up moves the whole band, while negotiating inside a band moves you a few lakh.',
        reachWhen: [
          'The recruiter tells you the range for the role.',
          'An offer lands below what you expected — ask which level it is at.',
          'Before the final round — ask which level you are being considered for.',
        ],
        tradeoffs: [
          'Asking above the top of the band rarely works without a competing offer.',
          'Asking for a higher level needs evidence: scope you have already owned at that level.',
          'Some companies, often services firms, still price off your current CTC with a hike cap. Find out which kind of company this is early.',
        ],
        say: 'Which level is this offer at, and what is the range for that level? I would like to understand where in the band I have been placed, and why.',
        check: {
          q: 'Why is asking "which level?" often worth more than haggling over the number?',
          a: 'The band is attached to the level. One level up moves the whole range, and every future raise compounds from it; haggling inside a band gains a few lakh, once.',
        },
        related: ['market-research', 'big-jump-objection'],
      },
      {
        id: 'market-research',
        title: 'Finding your market rate',
        what: 'An evidence-backed range for what this role pays at this level, gathered before any call.',
        does: 'Sources: levels.fyi (best for large tech companies, by level), AmbitionBox and Glassdoor (broader, noisier), LinkedIn salary insights, peers at the company, and recruiters — ask any recruiter who calls you what the range is; they usually tell you. Three independent sources that roughly agree give you a range you can defend out loud.',
        reachWhen: ['Before the first recruiter call.', 'Before you give any number at all.'],
        tradeoffs: [
          'Self-reported sites skew and lag. Treat them as a range, never as a figure.',
          'Match levels, not titles — "senior engineer" is a different level at different companies.',
        ],
        say: 'From what I see for this level in the market, the range is roughly <X> to <Y>, and given the scope of this role I am targeting the upper half.',
        check: {
          q: 'Name three sources for a market range, and one weakness of self-reported salary sites.',
          a: 'Any three of levels.fyi, AmbitionBox, Glassdoor, LinkedIn insights, recruiters and peers. They are self-reported, skewed and stale, and titles do not map cleanly onto levels.',
        },
        related: ['bands-levels', 'anchoring'],
      },
      {
        id: 'hike-math',
        title: 'The arithmetic of a big jump',
        what: 'Knowing exactly how big your ask is relative to current pay, before anyone says it to you.',
        does: '21 to 70 is 3.3 times — a 233% hike, not 300%. Get it right, because a wrong figure said confidently by the recruiter is easier to accept than to correct. Jumps that size are normal in some moves — services to product, a level change, a high-demand skill, or after years of being underpaid — and rare within the same kind of company at the same level. Know which move you are making, because it is your justification.',
        reachWhen: ['Your target is more than double your current pay.', 'Before the call where the number will come up.'],
        tradeoffs: [
          'Framing your ask as a percentage invites a percentage answer. Frame it as what the level pays.',
          'If the move is the same kind of company at the same level, a very large jump is genuinely hard to justify — lean on level and competing offers, not on the percentage.',
        ],
        numbers: 'Hike % = (new − current) ÷ current × 100. From 21: to 30 is 43%, to 40 is 90%, to 50 is 138%, to 70 is 233%.',
        say: 'I do not think of it as a hike on my current pay. My current pay reflects a different company, band and scope; this number is what this level pays.',
        check: {
          q: 'Current CTC 21 LPA, target 45 LPA. What percentage hike is that?',
          a: '(45 − 21) ÷ 21 ≈ 114%.',
        },
        related: ['big-jump-objection', 'bands-levels'],
      },
    ],
  },

  {
    id: 'hr-holding',
    title: 'Holding your number',
    lead: 'The conversation itself: who speaks first, what to do with your current CTC, and what to say when they push back on the gap.',
    concepts: [
      {
        id: 'anchoring',
        title: 'Anchoring',
        core: true,
        what: 'The first number spoken pulls the final outcome towards it.',
        does: 'Name 35 when the band is 55 to 75 and you will be offered something near 35 — perhaps a little more, which will feel like a win. If they name the band first, you can aim at its top. That is why you deflect the first ask when you do not know the band: whoever has less information should not anchor. Once you DO know the band or the market rate, anchoring high inside it is the right move.',
        reachWhen: ['"What are your expectations?" before you know the band.', 'You know the band — then anchor near its top.'],
        tradeoffs: [
          'An anchor far beyond the band with no reason looks uninformed. Anchor at the top, or just above it with a reason.',
          'Refusing for ever stalls the process. Deflect once or twice, then give a number grounded in the role.',
        ],
        say: 'Based on the scope of the role and what this level pays in the market, I am targeting <top of band>.',
        check: {
          q: 'When should you be the one to name a number first?',
          a: 'When you know the band or the market range well — then anchor at or near its top. When you do not, ask for their range first.',
        },
        related: ['current-ctc', 'market-research'],
      },
      {
        id: 'current-ctc',
        title: 'When they ask for your current CTC',
        core: true,
        what: 'In India it is asked in almost every process, often on a form, and checked against payslips — so the skill is not hiding it but stopping it from becoming the anchor.',
        does: 'Do not volunteer it, and do not lead with it. When it is required, state it once, truthfully, split into fixed and variable, and in the same breath move the conversation to the role\'s band. Never inflate it: background verification commonly asks for payslips, Form 16 or your last offer letter, and a mismatch is grounds to withdraw an offer — even after you have resigned.',
        reachWhen: ['A "current CTC" field on the application form.', 'The recruiter asks in the first call.', 'HR asks for payslips before releasing the offer.'],
        tradeoffs: [
          'Refusing outright where it is required can stall or end the process. Deflect once; if they insist, say it and reframe.',
          'Quoting full target variable when you were paid less is a misstatement. Quote what is real, and say what it is made of.',
        ],
        say: 'My current CTC is 21, of which <X> is fixed. I would ask that the offer be based on this role\'s level and band rather than on that — I am moving into a broader scope.',
        check: {
          q: 'Why is inflating your current CTC a bad idea even when nobody asks for payslips at first?',
          a: 'Verification after the offer often asks for payslips, Form 16 or relieving letters. A mismatch is grounds to withdraw the offer, and by then you may have resigned.',
        },
        related: ['big-jump-objection', 'anchoring'],
      },
      {
        id: 'big-jump-objection',
        title: '"That is a 233% hike"',
        core: true,
        what: 'The standard pushback when your ask is far above your current pay — and it has a standard answer.',
        does: 'The objection assumes your current pay measures your worth. Your answer replaces that frame with three facts: they assessed you for THIS level; this level has a band; your current pay reflects a different company\'s band for a narrower role. Then hold the number, stay warm, and offer flexibility on the mix — never on the level. If they say policy caps the hike, ask what the cap is, whether it covers the joining bonus and stock as well as fixed pay, and whether a competing offer allows an exception.',
        reachWhen: ['They react to the gap between your current CTC and your ask.', '"We cannot go beyond X% over your current CTC."'],
        tradeoffs: [
          'A genuine hike cap may stop the fixed pay moving — then move the joining bonus, the stock grant or the level instead.',
          'Getting defensive, or apologising for the number, concedes their frame.',
          'If the level really is a stretch for you, the jump is harder to defend. Have two specific examples of scope at that level ready.',
        ],
        say: 'I understand it looks like a big jump from my current number. But you assessed me for this level, and the band for this level is what it is — my current pay reflects my current company\'s band, for a narrower role. I would like the offer to reflect the role.',
        check: {
          q: 'They say: "We can only offer 50% over your current CTC." Name two things to ask next.',
          a: 'Whether the cap covers the joining bonus and stock or only fixed pay; whether the offer could be at a level whose band starts higher; or whether a competing offer allows an exception. Any two.',
        },
        related: ['hike-math', 'beyond-base', 'batna'],
      },
      {
        id: 'counter',
        title: 'Making the counter-offer',
        what: 'Answering their first offer with one specific, justified number.',
        does: 'First offers nearly always have room. Thank them, say you are interested, ask for a day or two, then come back with ONE number — a range is heard as its bottom — and one reason: market, scope, or another offer. Then stop talking. The silence after your number is part of the move; whoever fills it usually concedes.',
        reachWhen: ['Any first offer.', 'A revised offer that is still short.'],
        tradeoffs: [
          'Countering the same item more than once or twice starts to cost goodwill.',
          'A counter far above the band with no leverage can end in a flat no. Stay at or just above the top of the band.',
        ],
        say: 'Thank you — I am excited about this role. Based on the scope and the market for this level, I was expecting <X>. If we can get to <X>, I am ready to accept.',
        check: {
          q: 'Why give one number rather than a range when you counter?',
          a: 'A range is heard as its lowest figure. One number anchors where you actually want to land.',
        },
        related: ['anchoring', 'batna'],
      },
      {
        id: 'batna',
        title: 'Leverage and your walk-away number',
        core: true,
        what: 'Your best alternative if this offer falls through, and the number below which you would decline.',
        does: 'Leverage only counts if it is true. A written competing offer is the strongest; an active final round elsewhere is moderate; "I am happy where I am" is weak unless you really are. Decide your walk-away number privately, before the call, so you are not deciding it under pressure with a number in front of you.',
        reachWhen: ['Before any negotiation call.', 'They ask whether you have other offers.'],
        tradeoffs: [
          'An invented offer is easy to check, and being caught ends the conversation.',
          'Sharing a competing number caps you at roughly that number. Share the fact of the offer, and the figure only when it helps.',
        ],
        say: 'I do have another offer with a higher fixed component, but this role is my first choice — if you can close the gap on fixed pay, I would like to make this work.',
        check: {
          q: 'Why decide your walk-away number before the call?',
          a: 'Under pressure people accept the number in front of them. A number decided calmly in advance reflects what you actually need.',
        },
        related: ['counter', 'big-jump-objection'],
      },
    ],
  },

  {
    id: 'hr-beyond',
    title: 'Everything but the base',
    lead: 'When the fixed pay will not move, the rest of the offer often will. And nothing agreed counts until it is in writing.',
    concepts: [
      {
        id: 'beyond-base',
        title: 'Levers beyond the base',
        what: 'The parts of an offer that can move when the fixed pay cannot.',
        does: 'A joining bonus is often the easiest — a one-time cost that does not touch the band. Then: the size and vesting of the stock grant; the level and title; a notice-period buyout; relocation; an early salary review, for example after six months, written into the offer letter; and remote or hybrid terms.',
        reachWhen: ['They say the base is fixed, or already at the top of the band.', 'A hike cap blocks the fixed component.'],
        tradeoffs: [
          'A joining bonus does not compound into future raises; fixed pay does. Prefer base when it is available.',
          'A promised early review is worth nothing unless it is in the offer letter.',
        ],
        say: 'If the fixed component is capped, could we bridge the gap with a joining bonus and a larger stock grant, and put a six-month review in the offer letter?',
        check: {
          q: 'Why is a joining bonus often easier to get than a higher base?',
          a: 'It is one-time and sits outside the band, so it creates no ongoing cost and no exception in the pay structure.',
        },
        related: ['ctc-breakdown', 'in-writing'],
      },
      {
        id: 'notice-buyout',
        title: 'Notice period and buyout',
        what: 'Notice periods of sixty to ninety days are common in India, they cost the hiring company time, and they are often negotiable.',
        does: 'Many companies will wait. Some will buy out your notice — pay your employer for the days you do not serve — or reimburse you for doing so. Know your own contract before the call: the notice length, whether a buyout is allowed, whether unused leave can be set against it, and the earliest date you can realistically join.',
        reachWhen: ['"When can you join?"', 'They want you sooner than your notice allows.'],
        tradeoffs: [
          'Promising a date you cannot deliver damages trust before you have started.',
          'Some employers refuse buyouts or early release. Check before you promise anything.',
        ],
        say: 'My notice period is ninety days. I can ask for early release, and if you can support a buyout I could join in about <X> weeks.',
        check: {
          q: 'Which three things in your current contract matter for a notice negotiation?',
          a: 'The notice length, whether a buyout is permitted, and whether unused leave can be adjusted against it.',
        },
        related: ['beyond-base'],
      },
      {
        id: 'retention-counter',
        title: 'When your current company counters',
        what: 'Your employer offers more money to keep you after you resign.',
        does: 'Decide BEFORE resigning whether any number would make you stay, and what it would be. Most reasons for leaving — scope, growth, a manager — are not fixed by money, and having signalled you are leaving can change how you are seen. Using the counter to squeeze the new company is high-risk: do it once and honestly, or not at all.',
        reachWhen: ['After you resign.'],
        tradeoffs: [
          'Accepting can be right if money genuinely was the only reason.',
          'Going back to the new company with a retention number can make them withdraw.',
        ],
        say: 'Thank you, I appreciate it — but this decision was about the role, not the pay.',
        check: {
          q: 'What should you decide before you resign?',
          a: 'Whether any counter-offer would make you stay, and at what number — so the decision is not made in an emotional conversation.',
        },
        related: ['batna'],
      },
      {
        id: 'in-writing',
        title: 'Get it in writing before you resign',
        what: 'Nothing agreed on a call exists until it is in the offer letter.',
        does: 'After a verbal agreement, ask for the revised offer letter with every component: fixed pay; variable target and how it is paid; joining bonus and its clawback; stock grant and vesting schedule; level and title; joining date; and any promised review. Do not resign until you have it, have read it, and have signed it.',
        reachWhen: ['After any verbal agreement.', 'Before you resign.'],
        tradeoffs: [
          'Exploding deadlines are a pressure tactic. Asking for two or three more days is normal and almost always granted.',
          'A component mentioned on the call but missing from the letter will not be paid.',
        ],
        say: 'That sounds good — could you send the revised offer letter with the full breakdown, so I can review it and sign?',
        check: {
          q: 'Name four things the offer letter must show before you resign.',
          a: 'Any four of: fixed pay, variable target and payout terms, joining bonus and clawback, stock and vesting schedule, level and title, joining date, a promised review.',
        },
        related: ['ctc-breakdown', 'beyond-base'],
      },
    ],
  },
];
