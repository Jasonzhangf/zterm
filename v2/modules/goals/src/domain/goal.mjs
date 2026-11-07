export const GOAL_STATUSES = Object.freeze(['active', 'completed', 'archived']);

export function isGoalStatus(value) {
  return GOAL_STATUSES.includes(value);
}

export function goalCopy(goal) {
  return {
    goalId: goal.goalId,
    workspaceId: goal.workspaceId,
    parentGoalId: goal.parentGoalId,
    name: goal.name,
    ownerMemberId: goal.ownerMemberId,
    status: goal.status,
  };
}

export function isGoalDescendant(goals, ancestorGoalId, candidateGoalId) {
  let current = goals[candidateGoalId];
  while (current && current.parentGoalId !== null) {
    if (current.parentGoalId === ancestorGoalId) return true;
    current = goals[current.parentGoalId];
  }
  return false;
}

export function hasChildGoal(goals, goalId) {
  return Object.values(goals).some((goal) => goal.parentGoalId === goalId);
}
