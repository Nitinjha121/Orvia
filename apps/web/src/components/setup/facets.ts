import { DIFF_COLOR } from '../../lib/colors';
import type { SurpriseFacet } from '../SurprisePanel';

export const DIFFICULTY_FACET: SurpriseFacet = {
  key: 'difficulty',
  label: 'Difficulty',
  options: [
    { value: 'easy', label: 'Easy' },
    { value: 'medium', label: 'Medium' },
    { value: 'hard', label: 'Hard' },
  ],
  colors: DIFF_COLOR,
};

export const DIFF_SHORT: Record<string, string> = { easy: 'Easy', medium: 'Med', hard: 'Hard' };
