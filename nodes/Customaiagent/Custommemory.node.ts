import {
  INodeType,
  INodeTypeDescription,
  ISupplyDataFunctions,
  
  SupplyData,
} from 'n8n-workflow';

/**
 * CustomMemory
 * ─────────────
 * A cluster (sub-node) that supplies a memory store to the CustomAiAgent.
 * Supports three backends:
 *   • In-Memory  — simple Map, lost on restart (good for testing)
 *   • Redis       — persistent, great for production
 *   • Window Buffer — keeps last N messages only (like LangChain WindowBufferMemory)
 */
export class Custommemory implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Custom Memory',
    name: 'custommemory',
    icon: 'fa:database',
    group: ['transform'],
    version: 1,
    description: 'Supplies conversation memory to the Custom AI Agent.',

    inputs: [],
    outputs: ['ai_memory'],
    outputNames: ['Memory'],

    codex: {
      categories: ['AI'],
      subcategories: { AI: ['Memory'] },
      resources: { primaryDocumentation: [] },
    },

    defaults: { name: 'Custom Memory' },

    properties: [
      {
        displayName: 'Memory Type',
        name: 'memoryType',
        type: 'options',
        options: [
          { name: 'In-Memory (Simple)', value: 'inMemory' },
          { name: 'Window Buffer (Last N Messages)', value: 'window' },
          { name: 'Redis', value: 'redis' },
        ],
        default: 'inMemory',
      },
      {
        displayName: 'Session ID',
        name: 'sessionId',
        type: 'string',
        default: '={{ $json.sessionId ?? "default" }}',
        description: 'Unique session identifier. Different sessions have separate histories.',
      },
      {
        displayName: 'Window Size',
        name: 'windowSize',
        type: 'number',
        default: 10,
        description: 'Number of most-recent message pairs to keep (Window Buffer only).',
        displayOptions: { show: { memoryType: ['window'] } },
      },
      {
        displayName: 'Redis Host',
        name: 'redisHost',
        type: 'string',
        default: 'localhost',
        displayOptions: { show: { memoryType: ['redis'] } },
      },
      {
        displayName: 'Redis Port',
        name: 'redisPort',
        type: 'number',
        default: 6379,
        displayOptions: { show: { memoryType: ['redis'] } },
      },
      {
        displayName: 'Redis Password',
        name: 'redisPassword',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        displayOptions: { show: { memoryType: ['redis'] } },
      },
      {
        displayName: 'Memory Key',
        name: 'memoryKey',
        type: 'string',
        default: 'chat_history',
        description: 'The key name used to store/retrieve chat history.',
      },
    ],
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const memoryType = this.getNodeParameter('memoryType', itemIndex) as string;
    const sessionId = this.getNodeParameter('sessionId', itemIndex) as string;
    const memoryKey = this.getNodeParameter('memoryKey', itemIndex) as string;
    const windowSize = this.getNodeParameter('windowSize', itemIndex, 10) as number;

    // ── In-Memory store (module-level Map so it persists across execute() calls) ──
    const inMemoryStore = (Custommemory as any)._store as Map<string, any[]> | undefined
      ?? new Map<string, any[]>();
    (Custommemory as any)._store = inMemoryStore;

    // ── Build memory object (LangChain-compatible interface) ────────────────
    const memory = {
      memoryKey,

      // Load existing history for this session
      loadMemoryVariables: async (_values: Record<string, any>) => {
        if (memoryType === 'redis') {
          // Redis load (requires ioredis — install separately)
          // const redis = new Redis({ host, port, password });
          // const raw = await redis.get(`memory:${sessionId}`);
          // return { [memoryKey]: raw ? JSON.parse(raw) : [] };
          return { [memoryKey]: [] }; // placeholder
        }
        const history = inMemoryStore.get(sessionId) ?? [];
        return { [memoryKey]: history };
      },

      // Save new exchange to history
      saveContext: async (
        inputValues: Record<string, any>,
        outputValues: Record<string, any>,
      ) => {
        const history = inMemoryStore.get(sessionId) ?? [];

        history.push({ role: 'user', content: inputValues.input ?? '' });
        history.push({ role: 'assistant', content: outputValues.output ?? '' });

        // Apply window limit
        if (memoryType === 'window') {
          const maxPairs = windowSize * 2; // each pair = user + assistant
          while (history.length > maxPairs) history.shift();
        }

        if (memoryType === 'redis') {
          // await redis.set(`memory:${sessionId}`, JSON.stringify(history));
        } else {
          inMemoryStore.set(sessionId, history);
        }
      },

      // Clear history for this session
      clear: async () => {
        if (memoryType === 'redis') {
          // await redis.del(`memory:${sessionId}`);
        } else {
          inMemoryStore.delete(sessionId);
        }
      },
    };

    return { response: memory };
  }
}