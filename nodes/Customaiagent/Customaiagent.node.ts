import {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  
  NodeOperationError,
} from 'n8n-workflow';

export class Customaiagent implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Custom AI Agent',
    name: 'customaiagent',
    icon: 'fa:robot',
    group: ['transform'],
    version: 1,
    description: 'A custom AI Agent that accepts Chat Model, Memory, and Tool sub-nodes',
    defaults: {
      name: 'Custom AI Agent',
    },

    // ── Inputs ──────────────────────────────────────────────────────────────
    // One main trigger input + three sub-node slots (Chat Model, Memory, Tools)
    inputs: [
      // Main data input (the chat message / trigger)
      {
        type: 'main',
        displayName: 'Input',
      },
      // Sub-node: Chat Model (required)
      {
        type: 'ai_languageModel',
        displayName: 'Chat Model',
        required: true,
        maxConnections: 1,
      },
      // Sub-node: Memory (optional)
      {
        type: 'ai_memory',
        displayName: 'Memory',
        required: false,
        maxConnections: 1,
      },
      // Sub-node: Tools (optional, multiple allowed)
      {
        type: 'ai_tool',
        displayName: 'Tools',
        required: false,
      },
    ],

    // ── Outputs ─────────────────────────────────────────────────────────────
    outputs: ['main'],
    outputNames: ['Response'],

    // ── UI Properties ────────────────────────────────────────────────────────
    properties: [
      {
        displayName: 'System Prompt',
        name: 'systemPrompt',
        type: 'string',
        typeOptions: { rows: 4 },
        default: 'You are a helpful assistant.',
        description: 'System prompt sent to the Chat Model at the start of every conversation.',
      },
      {
        displayName: 'User Message Field',
        name: 'userMessageField',
        type: 'string',
        default: 'chatInput',
        description: 'The field name in the incoming data that contains the user message.',
      },
      {
        displayName: 'Max Iterations',
        name: 'maxIterations',
        type: 'number',
        default: 10,
        description: 'Maximum number of tool-use iterations before the agent stops.',
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
          {
            displayName: 'Return Intermediate Steps',
            name: 'returnIntermediateSteps',
            type: 'boolean',
            default: false,
            description: 'Whether to return tool calls and intermediate reasoning in the output.',
          },
          {
            displayName: 'Memory Key',
            name: 'memoryKey',
            type: 'string',
            default: 'chat_history',
            description: 'The key used by the Memory sub-node to store history.',
          },
        ],
      },
    ],
  };

  // ── Execute ────────────────────────────────────────────────────────────────
  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const results: INodeExecutionData[] = [];

    // ── Pull sub-node connections ──────────────────────────────────────────
    // getInputConnectionData() retrieves the supplyData() return value from
    // each connected sub-node.

    // 1. Chat Model (required)
    const chatModel = (await this.getInputConnectionData('ai_languageModel',0,)) as any;

    if (!chatModel) {
      throw new NodeOperationError(
        this.getNode(),
        'No Chat Model connected. Please connect a Chat Model sub-node.',
      );
    }

    // 2. Memory (optional)
    let memory: any = null;
    try {
      memory = await this.getInputConnectionData('ai_memory', 0);
    } catch (_) {
      // Memory not connected — that's fine
    }

    // 3. Tools (optional, array)
    let tools: any[] = [];
    try {
      const toolsData = (await this.getInputConnectionData('ai_tool',0,)) as any[];
      if (Array.isArray(toolsData)) tools = toolsData;
      else if (toolsData) tools = [toolsData];
    } catch (_) {
      // No tools connected
    }

    // ── Node parameters ────────────────────────────────────────────────────
    const systemPrompt = this.getNodeParameter('systemPrompt', 0) as string;
    const userMessageField = this.getNodeParameter('userMessageField', 0) as string;
    const maxIterations = this.getNodeParameter('maxIterations', 0) as number;
    const options = this.getNodeParameter('options', 0, {}) as {
      returnIntermediateSteps?: boolean;
      memoryKey?: string;
    };

    const memoryKey = options.memoryKey ?? 'chat_history';
    const returnSteps = options.returnIntermediateSteps ?? false;

    // ── Process each incoming item ─────────────────────────────────────────
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const userMessage =
        (item.json[userMessageField] as string) ??
        (item.json['text'] as string) ??
        (item.json['message'] as string) ??
        '';

      if (!userMessage) {
        results.push({
          json: {
            error: `No message found in field "${userMessageField}"`,
            input: item.json,
          },
        });
        continue;
      }

      // ── Load history from Memory sub-node ────────────────────────────────
      let chatHistory: Array<{ role: string; content: string }> = [];
      if (memory && typeof memory.loadMemoryVariables === 'function') {
        try {
          const memVars = await memory.loadMemoryVariables({});
          chatHistory = memVars[memoryKey] ?? [];
        } catch (_) {}
      }

      // ── Build messages array ──────────────────────────────────────────────
      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: systemPrompt },
        ...chatHistory,
        { role: 'user', content: userMessage },
      ];

      // ── Agentic loop (tool calling) ───────────────────────────────────────
      const intermediateSteps: any[] = [];
      let finalResponse = '';
      let iterations = 0;
      let continueLoop = true;

      // Describe available tools to the model
      const toolDescriptions =
        tools.length > 0
          ? tools.map((t: any) => ({
              name: t.name ?? t.lc_id?.[2] ?? 'unknown_tool',
              description: t.description ?? '',
              parameters: t.schema ?? {},
            }))
          : [];

      while (continueLoop && iterations < maxIterations) {
        iterations++;

        // Call the Chat Model's invoke / call method
        let modelResponse: any;
        try {
          if (typeof chatModel.invoke === 'function') {
            // LangChain-style (most n8n chat models)
            modelResponse = await chatModel.invoke(messages);
          } else if (typeof chatModel.call === 'function') {
            modelResponse = await chatModel.call({ messages });
          } else {
            throw new Error('Chat model does not expose invoke() or call()');
          }
        } catch (err: any) {
          throw new NodeOperationError(this.getNode(), `Chat Model error: ${err.message}`);
        }

        // Extract text content
        const responseText: string =
          typeof modelResponse === 'string'
            ? modelResponse
            : modelResponse?.content ?? modelResponse?.text ?? JSON.stringify(modelResponse);

        // Check for tool call (simplified: detect JSON with "tool" key in response)
        let toolCallDetected = false;
        if (tools.length > 0 && toolDescriptions.length > 0) {
          try {
            const parsed = JSON.parse(responseText);
            if (parsed.tool && parsed.tool_input !== undefined) {
              toolCallDetected = true;
              const toolName: string = parsed.tool;
              const toolInput: any = parsed.tool_input;

              const matchedTool = tools.find(
                (t: any) =>
                  (t.name ?? t.lc_id?.[2] ?? '') === toolName,
              );

              let toolResult = 'Tool not found';
              if (matchedTool) {
                try {
                  toolResult =
                    typeof matchedTool.invoke === 'function'
                      ? await matchedTool.invoke(toolInput)
                      : await matchedTool.call(toolInput);
                } catch (toolErr: any) {
                  toolResult = `Tool error: ${toolErr.message}`;
                }
              }

              intermediateSteps.push({
                tool: toolName,
                toolInput,
                toolResult,
              });

              // Feed tool result back into messages
              messages.push({ role: 'assistant', content: responseText });
              messages.push({
                role: 'user',
                content: `Tool "${toolName}" returned: ${JSON.stringify(toolResult)}`,
              });
            }
          } catch (_) {
            // Not a JSON tool call — treat as final answer
          }
        }

        if (!toolCallDetected) {
          finalResponse = responseText;
          continueLoop = false;
        }
      }

      // ── Save to Memory ────────────────────────────────────────────────────
      if (memory && typeof memory.saveContext === 'function') {
        try {
          await memory.saveContext(
            { input: userMessage },
            { output: finalResponse },
          );
        } catch (_) {}
      }

      // ── Build output ──────────────────────────────────────────────────────
      const output: Record<string, any> = {
        response: finalResponse,
        userMessage,
        iterations,
        toolsUsed: intermediateSteps.map((s) => s.tool),
      };

      if (returnSteps) {
        output.intermediateSteps = intermediateSteps;
      }

      results.push({ json: output });
    }

    return [results];
  }
}