export interface ProbeChecks {
  check(condition: boolean, label: string): void;
  finish(failureNote: string, successNote: string): never;
}

export function probeChecks(): ProbeChecks {
  const failures: string[] = [];
  return {
    check(condition, label) {
      console.log(`${condition ? "✅" : "❌"} ${label}`);
      if (!condition) failures.push(label);
    },
    finish(failureNote, successNote) {
      if (failures.length > 0) {
        console.error(`\n${failures.length} ${failureNote}`);
        process.exit(1);
      }
      console.log(`\n${successNote}`);
      process.exit(0);
    },
  };
}
