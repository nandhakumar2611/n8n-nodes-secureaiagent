import {
  INodeType,
  INodeTypeDescription,
  ISupplyDataFunctions,
  
  SupplyData,
  NodeOperationError,
} from 'n8n-workflow';

/**
 * CustomTool
 * ──────────
 * A cluster (sub-node) that supplies a callable tool to the CustomAiAgent.
 * The agent can invoke this tool during its reasoning loop.
 *
 * Supported tool types:
 *   • HTTP Request  — calls an external API
 *   • JavaScript    — runs a JS snippet (eval-based, sandbox in production!)
 *   • n8n Workflow  — triggers another n8n workflow as a sub-tool
 */
export class Customtool implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Custom Tool',
    name: 'customtool',
    icon: 'fa:wrench',
    group: ['transform'],
    version: 1,
    description: 'Supplies a callable tool to the Custom AI Agent.',

    inputs: [],
    outputs: ['ai_tool'],
    outputNames: ['Tool'],

    codex: {
      categories: ['AI'],
      subcategories: { AI: ['Tools'] },
      resources: { primaryDocumentation: [] },
    },

    defaults: { name: 'Custom Tool' },

    properties: [
      // ── Identity ────────────────────────────────────────────────────────
      {
        displayName: 'Tool Name',
        name: 'toolName',
        type: 'string',
        default: 'my_tool',
        description: 'Snake_case name the agent uses to call this tool (e.g. get_weather).',
        required: true,
      },
      {
        displayName: 'Description',
        name: 'toolDescription',
        type: 'string',
        typeOptions: { rows: 3 },
        default: 'Describe what this tool does so the AI knows when to use it.',
        required: true,
      },

      // ── Tool type ───────────────────────────────────────────────────────
      {
        displayName: 'Tool Type',
        name: 'toolType',
        type: 'options',
        options: [
          { name: 'HTTP Request', value: 'http' },
          { name: 'JavaScript Code', value: 'javascript' },
          { name: 'Static Response (Mock)', value: 'mock' },
        ],
        default: 'mock',
      },

      // ── HTTP options ────────────────────────────────────────────────────
      {
        displayName: 'URL',
        name: 'httpUrl',
        type: 'string',
        default: 'https://api.example.com/data',
        displayOptions: { show: { toolType: ['http'] } },
        description: 'Use {{ $input.param }} to inject agent-supplied arguments into the URL.',
      },
      {
        displayName: 'HTTP Method',
        name: 'httpMethod',
        type: 'options',
        options: [
          { name: 'GET', value: 'GET' },
          { name: 'POST', value: 'POST' },
          { name: 'PUT', value: 'PUT' },
          { name: 'DELETE', value: 'DELETE' },
        ],
        default: 'GET',
        displayOptions: { show: { toolType: ['http'] } },
      },
      {
        displayName: 'Body (JSON)',
        name: 'httpBody',
        type: 'json',
        default: '{}',
        displayOptions: { show: { toolType: ['http'], httpMethod: ['POST', 'PUT'] } },
        description: 'Request body. Use {{ $input.key }} for agent-supplied values.',
      },
      {
        displayName: 'Headers (JSON)',
        name: 'httpHeaders',
        type: 'json',
        default: '{"Content-Type":"application/json"}',
        displayOptions: { show: { toolType: ['http'] } },
      },

      // ── JS Code options ─────────────────────────────────────────────────
      {
        displayName: 'JavaScript Code',
        name: 'jsCode',
        type: 'string',
        typeOptions: { rows: 10 },
        default: `// $input contains the parameters the agent passed to this tool.
// Return the result as a string or JSON-serialisable object.
const { query } = $input;
return \`You searched for: \${query}\`;`,
        displayOptions: { show: { toolType: ['javascript'] } },
      },

      // ── Mock ─────────────────────────────────────────────────────────────
      {
        displayName: 'Mock Response',
        name: 'mockResponse',
        type: 'string',
        typeOptions: { rows: 3 },
        default: 'This is a mock tool response.',
        displayOptions: { show: { toolType: ['mock'] } },
      },

      // ── Input schema ─────────────────────────────────────────────────────
      {
        displayName: 'Input Parameters',
        name: 'inputParameters',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: { parameters: [{ name: 'query', type: 'string', description: 'Search query', required: true }] },
        description: 'Define the parameters the AI must provide when calling this tool.',
        options: [
          {
            name: 'parameters',
            displayName: 'Parameter',
            values: [
              { displayName: 'Name', name: 'name', type: 'string', default: '' },
              {
                displayName: 'Type',
                name: 'type',
                type: 'options',
                options: [
                  { name: 'String', value: 'string' },
                  { name: 'Number', value: 'number' },
                  { name: 'Boolean', value: 'boolean' },
                ],
                default: 'string',
              },
              { displayName: 'Description', name: 'description', type: 'string', default: '' },
              { displayName: 'Required', name: 'required', type: 'boolean', default: true },
            ],
          },
        ],
      },
    ],
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const toolName = this.getNodeParameter('toolName', itemIndex) as string;
    const toolDescription = this.getNodeParameter('toolDescription', itemIndex) as string;
    const toolType = this.getNodeParameter('toolType', itemIndex) as string;

    // Build JSON schema from configured parameters
    const inputParams = (
      this.getNodeParameter('inputParameters', itemIndex, { parameters: [] }) as any
    ).parameters ?? [];

    const schema: Record<string, any> = {
      type: 'object',
      properties: {},
      required: [],
    };
    for (const p of inputParams) {
      schema.properties[p.name] = { type: p.type, description: p.description };
      if (p.required) schema.required.push(p.name);
    }

    // ── Tool object (invoke-able by the parent agent) ───────────────────────
    const tool = {
      name: toolName,
      description: toolDescription,
      schema,

      invoke: async (input: Record<string, any>): Promise<string> => {
        switch (toolType) {
          // ── HTTP Request ─────────────────────────────────────────────────
          case 'http': {
            let url = this.getNodeParameter('httpUrl', itemIndex) as string;
            const method = this.getNodeParameter('httpMethod', itemIndex) as string;
            const rawHeaders = this.getNodeParameter('httpHeaders', itemIndex, '{}') as string;

            // Inject input values into URL template {{key}} → value
            for (const [k, v] of Object.entries(input)) {
              url = url.replace(new RegExp(`\\{\\{\\s*\\$input\\.${k}\\s*\\}\\}`, 'g'), String(v));
            }

            const headers = typeof rawHeaders === 'string' ? JSON.parse(rawHeaders) : rawHeaders;
            const fetchOptions: RequestInit = { method, headers };

            if (['POST', 'PUT'].includes(method)) {
              const rawBody = this.getNodeParameter('httpBody', itemIndex, '{}') as string;
              let body = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
              // Merge input into body
              body = { ...body, ...input };
              fetchOptions.body = JSON.stringify(body);
            }

            const res = await fetch(url, fetchOptions);
            if (!res.ok) {
              throw new NodeOperationError(
                this.getNode(),
                `Tool HTTP error ${res.status}: ${await res.text()}`,
              );
            }
            const contentType = res.headers.get('content-type') ?? '';
            return contentType.includes('application/json')
              ? JSON.stringify(await res.json())
              : await res.text();
          }

          // ── JavaScript Code ──────────────────────────────────────────────
          case 'javascript': {
            const jsCode = this.getNodeParameter('jsCode', itemIndex) as string;
            // eslint-disable-next-line no-new-func
            const fn = new Function('$input', jsCode);
            const result = await fn(input);
            return typeof result === 'string' ? result : JSON.stringify(result);
          }

          // ── Mock ─────────────────────────────────────────────────────────
          default: {
            const mockResponse = this.getNodeParameter('mockResponse', itemIndex) as string;
            return mockResponse;
          }
        }
      },
    };

    return { response: tool };
  }
}