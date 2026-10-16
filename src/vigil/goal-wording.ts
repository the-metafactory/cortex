export type GoalWordingResolver = (goalId: string) => string | null | Promise<string | null>;

export const idOnlyGoalWording: GoalWordingResolver = (goalId) => goalId;
