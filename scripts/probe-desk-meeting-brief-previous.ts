import { meetingBriefPreviousHttpProbe } from "../src/surface/mc/__tests__/fixtures/meeting-brief-previous-http";

console.log(JSON.stringify(await meetingBriefPreviousHttpProbe(), null, 2));
