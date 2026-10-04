// Syllabus areas from SKILL.md section 2 (SEAB 9570, 2026 syllabus).
// `paper2` marks whether a topic belongs to Section A (micro) or B (macro).

export const THEMES = [
  {
    id: 'T1',
    title: 'Theme 1: The Central Economic Problem',
    section: 'A',
    topics: [
      { code: '1.1.1', label: 'Scarcity, choice, opportunity cost & the PPC' },
      { code: '1.1.2', label: 'Rational decision-making & the marginalist principle' },
    ],
  },
  {
    id: 'T2',
    title: 'Theme 2: Markets',
    section: 'A',
    topics: [
      { code: '2.1.1', label: 'Price mechanism: signalling, incentive, rationing' },
      { code: '2.1.2', label: 'Demand & supply, elasticities (PED, PES, YED, XED), labour market' },
      { code: '2.1.3', label: 'Taxes, subsidies, price controls & quotas' },
      { code: '2.2.1', label: 'Firms’ objectives (profit max, satisficing, revenue max)' },
      { code: '2.2.2', label: 'Costs, revenues & economies of scale' },
      { code: '2.2.3', label: 'Firms’ decisions & strategies (pricing, R&D, collusion, exit)' },
      { code: '2.3.1', label: 'Efficiency & equity' },
      { code: '2.3.2', label: 'Market failure (public goods, externalities, information, dominance)' },
      { code: '2.3.3', label: 'Micro policies, nudges & government failure' },
    ],
  },
  {
    id: 'T3',
    title: 'Theme 3: The National & International Economy',
    section: 'B',
    topics: [
      { code: '3.1.1', label: 'Circular flow of income' },
      { code: '3.1.2', label: 'AD/AS & the multiplier' },
      { code: '3.2.1', label: 'Standard of living & indicators (GDP, HDI, Gini)' },
      { code: '3.2.2', label: 'Macro issues: growth, unemployment, inflation, BOT' },
      { code: '3.2.3', label: 'Fiscal, monetary (MAS exchange rate) & supply-side policy' },
      { code: '3.3.1', label: 'Globalisation, trade, protectionism & FTAs' },
    ],
  },
];

export const ALL_TOPICS = THEMES.flatMap((t) =>
  t.topics.map((topic) => ({ ...topic, theme: t.id, section: t.section })),
);

export function topicByCode(code) {
  return ALL_TOPICS.find((t) => t.code === code);
}
