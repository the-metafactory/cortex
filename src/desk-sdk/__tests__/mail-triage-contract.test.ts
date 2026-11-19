import { expect, test } from "bun:test";
import { MAIL_CATEGORIES, SUGGESTED_ACTIONS, PREDICTED_ACTIONS } from "../index";
import { MAIL_CATEGORIES as classifierCategories, SUGGESTED_ACTIONS as classifierSuggestions, PREDICTED_ACTIONS as classifierPredictions } from "../../surface/mc/desk/classify";
import { PREDICTED_ACTIONS as wirePredictions } from "../../desk-api/wire/mail";

test("the SDK exports the classifier and Desk API mail-triage arrays by reference", () => {
  expect(MAIL_CATEGORIES).toBe(classifierCategories);
  expect(SUGGESTED_ACTIONS).toBe(classifierSuggestions);
  expect(PREDICTED_ACTIONS).toBe(classifierPredictions);
  expect(PREDICTED_ACTIONS).toBe(wirePredictions);
});
