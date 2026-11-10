import { randomUUID } from "node:crypto";

const ADAPTER = "sample.plants";
const VERSION = "1.0.0";
const PAGE_SIZE = 2;
const DAY_MS = 86_400_000;

const schemaRef = name => ({ schemaId: `${ADAPTER}.${name}`, version: VERSION });
const PLANT_REF = schemaRef("plant");
const ROOM_REF = schemaRef("room");
const EMPTY_REF = schemaRef("empty");
const ERROR_REF = schemaRef("error");

const roomReference = {
  type: "object",
  title: "Room",
  additionalProperties: false,
  required: ["adapterId", "connectionId", "objectType", "canonicalId"],
  properties: {
    adapterId: { type: "string", const: ADAPTER },
    connectionId: { type: "string", minLength: 1 },
    objectType: { type: "string", const: "room" },
    canonicalId: { type: "string", minLength: 1 },
  },
};

const objectRefTo = name => ({ $ref: `urn:desk-schema:${ADAPTER}.${name}:${VERSION}` });

const declaration = {
  adapterId: ADAPTER,
  label: "Plant care",
  contractRange: "^1.0.0",
  schemas: [
    { ...EMPTY_REF, schema: { type: "object", additionalProperties: false, properties: {} } },
    {
      ...ERROR_REF,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["code", "message"],
        properties: { code: { type: "string" }, message: { type: "string" }, issues: { type: "array", items: { type: "object" } } },
      },
    },
    {
      ...ROOM_REF,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: { id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 } },
      },
    },
    {
      ...PLANT_REF,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "species", "room", "roomName", "wateringIntervalHours", "lastWatered", "nextWaterDue", "careNote"],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          species: { type: "string" },
          room: roomReference,
          roomName: { type: "string", minLength: 1 },
          wateringIntervalHours: { type: "integer", minimum: 1 },
          lastWatered: { type: "string", format: "date-time" },
          nextWaterDue: { type: "string", format: "date" },
          careNote: { type: "string" },
        },
      },
    },
    {
      ...schemaRef("plant-list"),
      schema: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: objectRefTo("plant") } } },
    },
    {
      ...schemaRef("room-list"),
      schema: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: objectRefTo("room") } } },
    },
    {
      ...schemaRef("search-input"),
      schema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", title: "Search text" } } },
    },
    {
      ...schemaRef("get-input"),
      schema: { type: "object", additionalProperties: false, required: ["canonicalId"], properties: { canonicalId: { type: "string", minLength: 1 } } },
    },
    {
      ...schemaRef("add-input"),
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["name", "room", "wateringIntervalDays"],
        properties: {
          name: { type: "string", minLength: 1, title: "Plant name" },
          room: roomReference,
          wateringIntervalDays: { type: "number", minimum: 1, title: "Water every (days)" },
          notes: { type: "string", title: "Care notes" },
        },
      },
    },
    {
      ...schemaRef("add-output"),
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["canonicalId", "wateringIntervalHours"],
        properties: { canonicalId: { type: "string", minLength: 1 }, wateringIntervalHours: { type: "integer", minimum: 1 } },
      },
    },
  ],
  objectTypes: [
    { objectType: "room", label: "room", schemaRef: ROOM_REF, relationships: [] },
    {
      objectType: "plant",
      label: "plant",
      schemaRef: PLANT_REF,
      relationships: [{ fieldPath: "/room", targetAdapterId: ADAPTER, targetObjectType: "room", cardinality: "one" }],
    },
  ],
  capabilities: [
    { capabilityId: `${ADAPTER}.rooms`, label: "List rooms", kind: "query", objectTypes: ["room"], inputSchemaRef: EMPTY_REF, outputSchemaRef: schemaRef("room-list"), errorSchemaRef: ERROR_REF },
    { capabilityId: `${ADAPTER}.thirsty`, label: "Plants that need water", kind: "observation", objectTypes: ["plant"], inputSchemaRef: EMPTY_REF, outputSchemaRef: schemaRef("plant-list"), errorSchemaRef: ERROR_REF },
    { capabilityId: `${ADAPTER}.search`, label: "Search plants", kind: "query", objectTypes: ["plant"], inputSchemaRef: schemaRef("search-input"), outputSchemaRef: schemaRef("plant-list"), errorSchemaRef: ERROR_REF },
    { capabilityId: `${ADAPTER}.get`, label: "Read one plant", kind: "query", objectTypes: ["plant"], inputSchemaRef: schemaRef("get-input"), outputSchemaRef: PLANT_REF, errorSchemaRef: ERROR_REF },
    { capabilityId: `${ADAPTER}.add`, label: "Add a plant", kind: "action", objectTypes: ["plant"], inputSchemaRef: schemaRef("add-input"), outputSchemaRef: schemaRef("add-output"), errorSchemaRef: ERROR_REF },
  ],
};

const ROOMS = [
  { id: "room-kitchen", name: "Kitchen" },
  { id: "room-study", name: "Study" },
  { id: "room-bedroom", name: "Bedroom" },
];

const isoDate = ms => new Date(ms).toISOString().slice(0, 10);
const isoTime = ms => new Date(ms).toISOString();

function storedPlant(id, name, species, roomId, intervalHours, lastWateredMs, careNote) {
  return { id, name, species, roomId, intervalHours, lastWateredMs, careNote, revision: "rev-1" };
}

const moduleLoadedAt = Date.now();
const plants = new Map(
  [
    storedPlant("plant-boston", "Boston fern", "Nephrolepis exaltata", "room-kitchen", 72, moduleLoadedAt - 9 * DAY_MS, "Fronds are drooping."),
    storedPlant("plant-maidenhair", "Maidenhair fern", "Adiantum raddianum", "room-study", 48, moduleLoadedAt - 4 * DAY_MS, "Soil is dry to the touch."),
    storedPlant("plant-birdsnest", "Bird's nest fern", "Asplenium nidus", "room-bedroom", 168, moduleLoadedAt - 1 * DAY_MS, "Doing well."),
    storedPlant("plant-monstera", "Monstera", "Monstera deliciosa", "room-study", 168, moduleLoadedAt - 2 * DAY_MS, "Doing well."),
    storedPlant("plant-pothos", "Pothos", "Epipremnum aureum", "room-kitchen", 240, moduleLoadedAt - 3 * DAY_MS, "Doing well."),
  ].map(plant => [plant.id, plant]),
);

const roomName = id => ROOMS.find(room => room.id === id)?.name ?? id;
const roomRefFor = (connectionId, canonicalId) => ({ adapterId: ADAPTER, connectionId, objectType: "room", canonicalId });
const dueMs = plant => plant.lastWateredMs + plant.intervalHours * 3_600_000;

function plantObject(plant, connectionId) {
  return {
    id: plant.id,
    name: plant.name,
    species: plant.species,
    room: roomRefFor(connectionId, plant.roomId),
    roomName: roomName(plant.roomId),
    wateringIntervalHours: plant.intervalHours,
    lastWatered: isoTime(plant.lastWateredMs),
    nextWaterDue: isoDate(dueMs(plant)),
    careNote: plant.careNote,
  };
}

function plantAnnotation(plant, connectionId, pointer) {
  return {
    pointer,
    ref: { adapterId: ADAPTER, connectionId, objectType: "plant", canonicalId: plant.id },
    objectSchemaRef: PLANT_REF,
    ownerRevision: plant.revision,
    destination: roomRefFor(connectionId, plant.roomId),
  };
}

function plantListResponse(list, connectionId, continuation) {
  return {
    payload: { items: list.map(plant => plantObject(plant, connectionId)) },
    annotations: list.map((plant, index) => plantAnnotation(plant, connectionId, `/items/${index}`)),
    ...(continuation ? { continuation } : {}),
    observedAt: isoTime(Date.now()),
    consistency: "snapshot",
  };
}

function listRooms(_input, context) {
  return {
    payload: { items: ROOMS },
    annotations: ROOMS.map((room, index) => ({
      pointer: `/items/${index}`,
      ref: roomRefFor(context.connectionId, room.id),
      objectSchemaRef: ROOM_REF,
      ownerRevision: "rev-1",
    })),
    observedAt: isoTime(Date.now()),
    consistency: "snapshot",
  };
}

function searchPlants(input, context) {
  const needle = input.text.trim().toLowerCase();
  const matches = [...plants.values()].filter(plant =>
    [plant.name, plant.species, roomName(plant.roomId), plant.careNote].some(text => text.toLowerCase().includes(needle)),
  );
  const offset = context.continuation ? Number(context.continuation) : 0;
  const next = offset + PAGE_SIZE;
  return plantListResponse(matches.slice(offset, next), context.connectionId, next < matches.length ? String(next) : undefined);
}

function getPlant(input, context) {
  const plant = plants.get(input.canonicalId);
  if (!plant) throw new Error("Unknown plant.");
  return {
    payload: plantObject(plant, context.connectionId),
    annotations: [plantAnnotation(plant, context.connectionId, "")],
    observedAt: isoTime(Date.now()),
    consistency: "snapshot",
  };
}

function pollThirsty(context) {
  const now = Date.now();
  return plantListResponse([...plants.values()].filter(plant => dueMs(plant) < now), context.connectionId);
}

function addPlantHandlerIsNotUsed() {
  throw new Error("Adding a plant runs through the registered connector.");
}

function connectPlants(connection) {
  const { connectionId } = connection;
  return {
    support: {
      lifecycleVersion: "1.0.0",
      adapterId: ADAPTER,
      connectionId,
      capabilityId: `${ADAPTER}.add`,
      declarationId: `${ADAPTER}.add.support.v1`,
      dedup: { kind: "none" },
      operationLookup: "none",
      conditionalUpdate: "none",
      cancellation: "none",
    },
    readbackCapabilityId: `${ADAPTER}.get`,
    async dispatch(request) {
      const { input } = request.snapshot;
      const now = Date.now();
      const plant = storedPlant(
        `plant-${randomUUID()}`,
        input.name,
        "",
        input.room.canonicalId,
        Math.round(input.wateringIntervalDays * 24),
        now,
        input.notes ?? "",
      );
      plants.set(plant.id, plant);
      return {
        lifecycleVersion: "1.0.0",
        operationId: request.operationId,
        attemptId: request.attemptId,
        snapshotDigest: request.snapshot.digest,
        resultId: randomUUID(),
        reportedAt: isoTime(now),
        result: {
          kind: "succeeded",
          output: { canonicalId: plant.id, wateringIntervalHours: plant.intervalHours },
          evidence: {
            kind: "effect",
            evidenceId: randomUUID(),
            observedAt: isoTime(now),
            ownerRequestId: request.ownerRequestId,
            receipt: { stored: plant.id },
            refs: [{ adapterId: ADAPTER, connectionId, objectType: "plant", canonicalId: plant.id }],
            ownerRevision: plant.revision,
          },
        },
      };
    },
    async readback(request) {
      const now = isoTime(Date.now());
      const plant = plants.get(request.ref.canonicalId);
      const envelope = {
        lifecycleVersion: "1.0.0",
        ref: request.ref,
        checkedAt: now,
        provenance: { adapterId: ADAPTER, connectionId, evidenceId: randomUUID() },
      };
      if (!plant) return { ...envelope, result: { kind: "unknown", reason: { code: `${ADAPTER}.unknown_plant`, message: "The plant is not stored." } } };
      return { ...envelope, result: { kind: "present", schemaRef: PLANT_REF, value: plantObject(plant, connectionId), ownerRevision: plant.revision, links: [] } };
    },
  };
}

export function createDeskAdapter(host) {
  host.registerConnector(`${ADAPTER}.add`, connectPlants);
  return {
    declaration,
    bindings: {
      handlers: {
        [`${ADAPTER}.rooms`]: listRooms,
        [`${ADAPTER}.search`]: searchPlants,
        [`${ADAPTER}.get`]: getPlant,
        [`${ADAPTER}.add`]: addPlantHandlerIsNotUsed,
      },
      observations: { [`${ADAPTER}.thirsty`]: { poll: pollThirsty } },
    },
  };
}
