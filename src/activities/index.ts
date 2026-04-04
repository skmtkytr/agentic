export { plannerActivity } from './plannerActivity';
export { taskDesignerActivity } from './taskDesignerActivity';
export { executorActivity } from './executorActivity';
export { reviewerActivity } from './reviewerActivity';
export { integratorActivity } from './integratorActivity';
export { integrationReviewerActivity } from './integrationReviewerActivity';

import { plannerActivity } from './plannerActivity';
import { taskDesignerActivity } from './taskDesignerActivity';
import { executorActivity } from './executorActivity';
import { reviewerActivity } from './reviewerActivity';
import { integratorActivity } from './integratorActivity';
import { integrationReviewerActivity } from './integrationReviewerActivity';

export const activities = {
  plannerActivity,
  taskDesignerActivity,
  executorActivity,
  reviewerActivity,
  integratorActivity,
  integrationReviewerActivity,
};

export type Activities = typeof activities;
