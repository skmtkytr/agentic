export { plannerActivity } from './plannerActivity';
export { validatorActivity } from './validatorActivity';
export { executorActivity } from './executorActivity';
export { reviewerActivity } from './reviewerActivity';
export { integratorActivity } from './integratorActivity';
export { integrationReviewerActivity } from './integrationReviewerActivity';

import { plannerActivity } from './plannerActivity';
import { validatorActivity } from './validatorActivity';
import { executorActivity } from './executorActivity';
import { reviewerActivity } from './reviewerActivity';
import { integratorActivity } from './integratorActivity';
import { integrationReviewerActivity } from './integrationReviewerActivity';

export const activities = {
  plannerActivity,
  validatorActivity,
  executorActivity,
  reviewerActivity,
  integratorActivity,
  integrationReviewerActivity,
};

export type Activities = typeof activities;
