import {
  INodeType,
  INodeTypeDescription,
  ISupplyDataFunctions,
  
  SupplyData,
  NodeOperationError,
} from 'n8n-workflow';

/**
 * CustomChatModel
 * ───────────────
 * A cluster (sub-node) that supplies a chat model to the CustomAiAgent parent.
 * It connects via the AiLanguageModel connection type — just like OpenAI Chat Model
 * connects to the built-in AI Agent.
 *
 * In real usage, replace the mock `invoke()` below with your actual LLM SDK call
 * (OpenAI, Anthropic, Ollama, etc.).
 */
export class Customchatmodel implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Custom Chat Model',
    name: 'customchatmodel',
    icon: 'fa:brain',
    group: ['transform'],
    version: 1,
    description: 'Supplies a Chat Model to the Custom AI Agent. Replace with your LLM provider.',

    // Sub-nodes have NO main input — they only output to the parent
    inputs: [],

    // Output type must match what the parent expects on that slot
    outputs: ['ai_languageModel'],
    outputNames: ['Model'],

    // Shown under the parent's "Chat Model" label in the canvas
    codex: {
      categories: ['AI'],
      subcategories: { AI: ['Language Models'] },
      resources: { primaryDocumentation: [] },
    },

    defaults: {
      name: 'Custom Chat Model',
    },

    properties: [
      {
        displayName: 'Provider',
        name: 'provider',
        type: 'options',
        options: [
          { name: 'OpenAI (GPT-4o)', value: 'openai' },
          { name: 'Anthropic (Claude)', value: 'anthropic' },
          { name: 'Ollama (Local)', value: 'ollama' },
          { name: 'Custom / Mock', value: 'mock' },
        ],
        default: 'mock',
        description: 'Which LLM provider to use.',
      },
      {
        displayName: 'Model Name',
        name: 'modelName',
        type: 'string',
        default: 'gpt-4o',
        description: 'Model identifier (e.g. gpt-4o, claude-3-5-sonnet, llama3).',
      },
      {
        displayName: 'API Key',
        name: 'apiKey',
        type: 'string',
        typeOptions: { password: true },
        default: '',
        description: 'API key for the selected provider.',
        displayOptions: {
          show: {
            provider: ['openai', 'anthropic'],
          },
        },
      },
      {
        displayName: 'Ollama Base URL',
        name: 'ollamaBaseUrl',
        type: 'string',
        default: 'http://localhost:11434',
        displayOptions: {
          show: { provider: ['ollama'] },
        },
      },
      {
        displayName: 'Temperature',
        name: 'temperature',
        type: 'number',
        typeOptions: { minValue: 0, maxValue: 2, numberStepSize: 0.1 },
        default: 0.7,
      },
      {
        displayName: 'Max Tokens',
        name: 'maxTokens',
        type: 'number',
        default: 1024,
      },
    ],
  };

  // supplyData() is called by the parent node via getInputConnectionData()
  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const provider = this.getNodeParameter('provider', itemIndex) as string;
    const modelName = this.getNodeParameter('modelName', itemIndex) as string;
    const apiKey = this.getNodeParameter('apiKey', itemIndex, '') as string;
    const temperature = this.getNodeParameter('temperature', itemIndex) as number;
    const maxTokens = this.getNodeParameter('maxTokens', itemIndex) as number;
    const ollamaBaseUrl = this.getNodeParameter('ollamaBaseUrl', itemIndex, 'http://localhost:11434') as string;

    // Build a model object with a unified invoke() interface.
    // The CustomAiAgent calls model.invoke(messages).
    const model = {
      name: modelName,
      provider,

      invoke: async (messages: Array<{ role: string; content: string }>) => {
        switch (provider) {
          // ── OpenAI ────────────────────────────────────────────────────────
          case 'openai': {
            if (!apiKey) throw new NodeOperationError(this.getNode(), 'OpenAI API key is required.');
            const res = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify({ model: modelName, messages, temperature, max_tokens: maxTokens }),
            });
            const data = await res.json() as any;
            if (data.error) throw new NodeOperationError(this.getNode(), data.error.message);
            return data.choices[0].message.content as string;
          }

          // ── Anthropic ─────────────────────────────────────────────────────
          case 'anthropic': {
            if (!apiKey) throw new NodeOperationError(this.getNode(), 'Anthropic API key is required.');
            // Anthropic requires system separate from messages
            const systemMsg = messages.find((m) => m.role === 'system');
            const userMessages = messages.filter((m) => m.role !== 'system');
            const res = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: modelName,
                max_tokens: maxTokens,
                system: systemMsg?.content ?? 'You are a helpful assistant.',
                messages: userMessages,
              }),
            });
            const data = await res.json() as any;
            if (data.error) throw new NodeOperationError(this.getNode(), data.error.message);
            return data.content[0].text as string;
          }

          // ── Ollama (local) ────────────────────────────────────────────────
          case 'ollama': {
            const res = await fetch(`${ollamaBaseUrl}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: modelName,
                messages,
                stream: false,
                options: { temperature, num_predict: maxTokens },
              }),
            });
            const data = await res.json() as any;
            return data.message?.content as string;
          }

          // ── Mock (for testing without an API key) ─────────────────────────
          default: {
            const last = messages[messages.length - 1];
            return `[Mock response to: "${last.content.slice(0, 60)}..."]`;
          }
        }
      },
    };

    return { response: model };
  }
}