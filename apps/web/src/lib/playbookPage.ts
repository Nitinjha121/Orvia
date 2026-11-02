import type { ComponentType } from 'react';

/**
 * The playbook page is private: the public repo is exported without it. A glob
 * that matches nothing is empty instead of a build error, so the route, the nav
 * link and the study-page pointer all disappear when the file is absent.
 */
const found = import.meta.glob<{ PlaybookPage: ComponentType }>('../components/PlaybookPage.tsx');

export const loadPlaybookPage = Object.values(found)[0];
export const HAS_PLAYBOOK = loadPlaybookPage !== undefined;
