import { meetingBriefHttpProbe } from "../src/surface/mc/__tests__/fixtures/meeting-brief-http";

console.log(JSON.stringify(await meetingBriefHttpProbe(), null, 2));
