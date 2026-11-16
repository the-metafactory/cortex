export interface RulingChoice {
  label: string;
  consequence: string;
  ruling: string;
}

export interface RulingExplanation {
  sentence: string;
  choices: RulingChoice[];
}
