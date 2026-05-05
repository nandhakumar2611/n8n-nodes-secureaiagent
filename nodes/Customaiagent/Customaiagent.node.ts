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
    description: 'A custom AI Agent that handles Chat, Memory, and Tools via JSON parsing',
    defaults: {
      name: 'Custom AI Agent',
    },
    inputs: [
      { type: 'main', displayName: 'Input' },
      { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 },
      { type: 'ai_memory', displayName: 'Memory', required: false, maxConnections: 1 },
      { type: 'ai_tool', displayName: 'Tools', required: false },
    ],
    outputs: ['main'],
    outputNames: ['Response'],
    properties: [
      {
        displayName: 'System Prompt',
        name: 'systemPrompt',
        type: 'string',
        typeOptions: { rows: 4 },
        default: 'You are a helpful assistant. To use a tool, you MUST respond with a JSON object: {"tool": "tool_name", "tool_input": "query"}. Respond with ONLY the JSON when using tools.',
        description: 'Instructions for the AI, including how to format tool calls.',
      },
      {
        displayName: 'User Message Field',
        name: 'userMessageField',
        type: 'string',
        default: 'chatInput',
      },
      {
        displayName: 'Max Iterations',
        name: 'maxIterations',
        type: 'number',
        default: 5,
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
          },
          {
            displayName: 'Memory Key',
            name: 'memoryKey',
            type: 'string',
            default: 'chat_history',
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const results: INodeExecutionData[] = [];

    const chatModel = (await this.getInputConnectionData('ai_languageModel', 0)) as any;
    if (!chatModel) {
      throw new NodeOperationError(this.getNode(), 'No Chat Model connected.');
    }

    let memory: any = null;
    try { memory = await this.getInputConnectionData('ai_memory', 0); } catch (_) {}

    let tools: any[] = [];
    try {
      const toolsData = (await this.getInputConnectionData('ai_tool', 0)) as any;
      if (Array.isArray(toolsData)) tools = toolsData;
      else if (toolsData) tools = [toolsData];
    } catch (_) {}

    const systemPrompt = this.getNodeParameter('systemPrompt', 0) as string;
    const userMessageField = this.getNodeParameter('userMessageField', 0) as string;
    const maxIterations = this.getNodeParameter('maxIterations', 0) as number;
    const options = this.getNodeParameter('options', 0, {}) as any;
    const memoryKey = options.memoryKey ?? 'chat_history';

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const userMessage = (item.json[userMessageField] as string) || (item.json['text'] as string) || '';

      let chatHistory: any[] = [];
      if (memory?.loadMemoryVariables) {
        const memVars = await memory.loadMemoryVariables({});
        chatHistory = memVars[memoryKey] ?? [];
      }

      const messages: any[] = [
        { role: 'system', content: systemPrompt },
        ...chatHistory,
        { role: 'user', content: userMessage },
      ];

      const intermediateSteps: any[] = [];
      let finalResponse = '';
      let iterations = 0;
      let continueLoop = true;

      while (continueLoop && iterations < maxIterations) {
        iterations++;
        
        const modelResponse = await chatModel.invoke(messages);
        const responseText: string = modelResponse?.content ?? modelResponse?.text ?? String(modelResponse);

        let toolCallDetected = false;

        // Use Regex to find JSON even if surrounded by text or markdown blocks
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        
        if (jsonMatch && tools.length > 0) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.tool) {
              const toolName = parsed.tool;
              const toolInput = parsed.tool_input;

              // Case-insensitive tool matching
              const matchedTool = tools.find(t => {
                const tName = (t.name ?? t.lc_id?.[2] ?? '').toLowerCase();
                return tName === toolName.toLowerCase();
              });

              if (matchedTool) {
                toolCallDetected = true;
                const toolResult = typeof matchedTool.invoke === 'function' 
                  ? await matchedTool.invoke(toolInput) 
                  : await matchedTool.call(toolInput);

                intermediateSteps.push({ tool: toolName, input: toolInput, output: toolResult });

                // Update conversation for next iteration
                messages.push({ role: 'assistant', content: responseText });
                messages.push({ 
                  role: 'user', 
                  content: `Tool "${toolName}" result: ${JSON.stringify(toolResult)}` 
                });
              }
            }
          } catch (e) {
            // Found something that looked like JSON but wasn't; treat as text
          }
        }

        if (!toolCallDetected) {
          finalResponse = responseText;
          continueLoop = false;
        }
      }

      if (memory?.saveContext) {
        await memory.saveContext({ input: userMessage }, { output: finalResponse });
      }

      results.push({
        json: {
          response: finalResponse,
          toolsUsed: intermediateSteps.map(s => s.tool),
          iterations,
          ...(options.returnIntermediateSteps ? { intermediateSteps } : {}),
        }
      });
    }

    return [results];
  }
}