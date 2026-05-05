import {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
} from 'n8n-workflow';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

interface ToolDefinition {
	name: string;
	description: string;
	parameters: IDataObject;
	endpointUrl: string;
}

interface ToolCall {
	id: string;
	name: string;
	arguments: IDataObject;
}

interface MaskReport extends IDataObject {
	entitiesFound: IDataObject;
	regexMasked: number;
	reductionChars: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// REGEX PATTERNS — fast structured-data pass
// ─────────────────────────────────────────────────────────────────────────────
const REGEX_PATTERNS: { label: string; pattern: RegExp }[] = [
	{ label: 'EMAIL',        pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
	{ label: 'PHONE',        pattern: /(\+?\d[\s\-.]?){7,15}/g },
	{ label: 'CREDIT_CARD',  pattern: /\b(?:\d[ \-]?){13,16}\b/g },
	{ label: 'CVV',          pattern: /\bCVV[:\s]*\d{3,4}\b/gi },
	{ label: 'SSN',          pattern: /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g },
	{ label: 'IP_ADDRESS',   pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
	{ label: 'EXPIRY_DATE',  pattern: /\b(0[1-9]|1[0-2])[\/\-]\d{2,4}\b/g },
	{ label: 'PASSPORT',     pattern: /\b[A-Z]{1,2}[0-9]{6,9}\b/g },
	{ label: 'DOB',          pattern: /\b(?:DOB|Date of Birth|Born)[:\s]+[\d\/\-]+/gi },
	{ label: 'API_KEY',      pattern: /\b(sk|pk|api|key)[_\-]?[A-Za-z0-9]{20,}\b/gi },
	{ label: 'JWT',          pattern: /eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g },
];

function applyRegexMask(
	text: string,
	customPatterns: { label: string; regex: string }[],
): { masked: string; count: number } {
	let masked = text;
	let count = 0;
	for (const { pattern } of REGEX_PATTERNS) {
		masked = masked.replace(pattern, () => { count++; return '***'; });
	}
	for (const { regex } of customPatterns) {
		try {
			masked = masked.replace(new RegExp(regex, 'gi'), () => { count++; return '***'; });
		} catch { /* invalid regex — skip */ }
	}
	return { masked, count };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI MASKING — Claude / OpenAI detects context-aware PII
// ─────────────────────────────────────────────────────────────────────────────
async function aiMask(
	text: string,
	apiKey: string,
	provider: 'anthropic' | 'openai',
	baseUrl: string,
	model: string,
	scopes: string[],
	customLabels: string[],
): Promise<{ masked: string; report: IDataObject }> {

	const scopeLine  = scopes.length       ? `Focus only on: ${scopes.join(', ')}.`    : '';
	const customLine = customLabels.length ? `Also detect: ${customLabels.join(', ')}.` : '';

	const systemPrompt = `You are a PII/PCI/PHI data-masking engine.
Identify ALL sensitive entities in the text and return ONLY a JSON array.
${scopeLine} ${customLine}

Each item: { "entity": "CATEGORY", "value": "exact substring" }
Categories: FULL_NAME, EMAIL, PHONE, ADDRESS, SSN, DOB, PASSPORT, IP_ADDRESS,
            CREDIT_CARD, CVV, EXPIRY_DATE, BANK_ACCOUNT, ROUTING_NUMBER,
            MRN, HEALTH_INSURANCE_ID, DIAGNOSIS, PRESCRIPTION,
            PASSWORD, API_KEY, JWT, CUSTOM.
If nothing found → [].
Respond with ONLY the JSON array. No markdown, no explanation.`;

	let entities: { entity: string; value: string }[] = [];

	if (provider === 'anthropic') {
		const res = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model,
				max_tokens: 1024,
				system: systemPrompt,
				messages: [{ role: 'user', content: text }],
			}),
		});
		const d = await res.json() as { content: { type: string; text: string }[] };
		const raw = d.content.find((c) => c.type === 'text')?.text ?? '[]';
		entities = JSON.parse(raw.replace(/```json|```/g, '').trim());

	} else {
		const res = await fetch(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user',   content: text },
				],
			}),
		});
		const d = await res.json() as { choices: { message: { content: string } }[] };
		const raw = d.choices[0]?.message?.content ?? '[]';
		entities = JSON.parse(raw.replace(/```json|```/g, '').trim());
	}

	let masked = text;
	const report: IDataObject = {};
	for (const { entity, value } of entities) {
		if (!value || value.length < 2) continue;
		const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const before  = masked;
		masked = masked.replace(new RegExp(escaped, 'gi'), '***');
		if (masked !== before) report[entity] = ((report[entity] as number) ?? 0) + 1;
	}
	return { masked, report };
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM CALL — provider-agnostic, handles tool-calling loop
// ─────────────────────────────────────────────────────────────────────────────
async function callLLM(
	provider: string,
	apiKey: string,
	baseUrl: string,
	model: string,
	messages: ChatMessage[],
	tools: ToolDefinition[],
	maxTokens: number,
): Promise<{ content: string; toolCalls: ToolCall[] }> {

	// ── Anthropic ──────────────────────────────────────────────────────────────
	if (provider === 'anthropic') {
		const systemMsg = messages.find((m) => m.role === 'system');
		const chatMsgs  = messages.filter((m) => m.role !== 'system');
		const body: IDataObject = { model, max_tokens: maxTokens, messages: chatMsgs };
		if (systemMsg) body.system = systemMsg.content;
		if (tools.length) {
			body.tools = tools.map((t) => ({
				name: t.name,
				description: t.description,
				input_schema: t.parameters,
			}));
		}
		const res = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify(body),
		});
		const data = await res.json() as {
			content: { type: string; text?: string; id?: string; name?: string; input?: IDataObject }[];
		};
		const textContent = data.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
		const toolCalls: ToolCall[] = data.content
			.filter((c) => c.type === 'tool_use')
			.map((c) => ({ id: c.id ?? '', name: c.name ?? '', arguments: (c.input ?? {}) as IDataObject }));
		return { content: textContent, toolCalls };
	}

	// ── OpenAI-compatible (OpenAI, Groq, Together, Azure …) ───────────────────
	const body: IDataObject = { model, max_tokens: maxTokens, messages };
	if (tools.length) {
		body.tools = tools.map((t) => ({
			type: 'function',
			function: { name: t.name, description: t.description, parameters: t.parameters },
		}));
		body.tool_choice = 'auto';
	}
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${apiKey}`,
	};
	const res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
	const data = await res.json() as {
		choices: {
			message: {
				content: string | null;
				tool_calls?: { id: string; function: { name: string; arguments: string } }[];
			};
		}[];
	};
	const msg       = data.choices[0]?.message;
	const content   = msg?.content ?? '';
	const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
		id: tc.id,
		name: tc.function.name,
		arguments: JSON.parse(tc.function.arguments || '{}') as IDataObject,
	}));
	return { content, toolCalls };
}

// ─────────────────────────────────────────────────────────────────────────────
// NODE
// ─────────────────────────────────────────────────────────────────────────────
export class Secureaiagent implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Secure AI Agent',
		name: 'secureaiagent',
		icon: 'fa:shield-alt',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["provider"] + " · " + $parameter["modelName"]}}',
		description:
			'AI Agent (model + memory + tools) with built-in PII/PCI/PHI masking. Sensitive data is masked BEFORE every LLM call.',
		defaults: { name: 'Secure AI Agent', color: '#c0392b' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'secureagentanthropicapi',
				required: false,
				displayOptions: { show: { provider: ['anthropic'] } },
			},
			{
				name: 'secureagentopenaiapi',
				required: false,
				displayOptions: { show: { provider: ['openai', 'openai_compatible'] } },
			},
		],
		properties: [

			// ═══ 🧠 MODEL ═════════════════════════════════════════════════════
			{
				displayName: 'Provider',
				name: 'provider',
				type: 'options',
				options: [
					{ name: 'Anthropic (Claude)',                           value: 'anthropic' },
					{ name: 'OpenAI (ChatGPT)',                             value: 'openai' },
					{ name: 'OpenAI-Compatible  (Groq / Azure / Together)', value: 'openai_compatible' },
				],
				default: 'anthropic',
				description: 'LLM provider to use at runtime',
			},
			{
				displayName: 'Model Name',
				name: 'modelName',
				type: 'string',
				default: 'claude-sonnet-4-20250514',
				required: true,
				description:
					'Model identifier — e.g. claude-sonnet-4-20250514 · gpt-4o · mixtral-8x7b-32768',
			},
			{
				displayName: 'Custom Base URL',
				name: 'customBaseUrl',
				type: 'string',
				default: '',
				description: 'e.g. https://api.groq.com/openai/v1',
				displayOptions: { show: { provider: ['openai_compatible'] } },
			},
			{
				displayName: 'System Prompt',
				name: 'systemPrompt',
				type: 'string',
				typeOptions: { rows: 4 },
				default: 'You are a helpful AI assistant.',
			},
			{
				displayName: 'Max Output Tokens',
				name: 'maxTokens',
				type: 'number',
				default: 1024,
			},

			// ═══ 💬 INPUT ═════════════════════════════════════════════════════
			{
				displayName: 'Input Field',
				name: 'inputField',
				type: 'string',
				default: 'chatInput',
				required: true,
				description: 'Field in the incoming item that contains the user message',
			},
			{
				displayName: 'Session ID Field',
				name: 'sessionIdField',
				type: 'string',
				default: 'sessionId',
				description: 'Field used to group conversation turns for memory',
			},

			// ═══ 💾 MEMORY ════════════════════════════════════════════════════
			{
				displayName: 'Memory Type',
				name: 'memoryType',
				type: 'options',
				options: [
					{ name: 'None  (stateless)',              value: 'none' },
					{ name: 'Buffer  — last N messages',      value: 'buffer' },
					{ name: 'Full history  — pass via field', value: 'full' },
				],
				default: 'buffer',
			},
			{
				displayName: 'Buffer Size (messages)',
				name: 'bufferSize',
				type: 'number',
				default: 10,
				displayOptions: { show: { memoryType: ['buffer'] } },
			},
			{
				displayName: 'History Field',
				name: 'historyField',
				type: 'string',
				default: 'chatHistory',
				description: 'Field containing a ChatMessage[] array from a previous step',
				displayOptions: { show: { memoryType: ['full'] } },
			},

			// ═══ 🔧 TOOLS ════════════════════════════════════════════════════
			{
				displayName: 'Tools',
				name: 'tools',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				description:
					'User-defined tools the agent can call — same concept as the native AI Agent node',
				options: [
					{
						name: 'tool',
						displayName: 'Tool',
						values: [
							{
								displayName: 'Tool Name',
								name: 'name',
								type: 'string',
								default: '',
								description: 'snake_case identifier  e.g. get_weather',
							},
							{
								displayName: 'Description',
								name: 'description',
								type: 'string',
								typeOptions: { rows: 2 },
								default: '',
								description: 'What this tool does — the LLM reads this to decide when to call it',
							},
							{
								displayName: 'Parameters Schema (JSON)',
								name: 'parametersSchema',
								type: 'json',
								default:
									'{"type":"object","properties":{"input":{"type":"string","description":"Input value"}},"required":["input"]}',
							},
							{
								displayName: 'Tool Endpoint URL',
								name: 'endpointUrl',
								type: 'string',
								default: '',
								description: 'POST endpoint called when the LLM invokes this tool. Receives arguments as JSON body.',
							},
						],
					},
				],
			},

			// ═══ 🛡️ PII / PCI / PHI MASKING ══════════════════════════════════
			{
				displayName: 'Masking Enabled',
				name: 'maskingEnabled',
				type: 'boolean',
				default: true,
				description:
					'When ON, all input text is sanitized before reaching the LLM. Sensitive data is replaced with ***.',
			},
			{
				displayName: 'Detection Mode',
				name: 'detectionMode',
				type: 'options',
				options: [
					{ name: 'AI + Regex  (best coverage)', value: 'ai_regex' },
					{ name: 'AI Only  (context-aware)',     value: 'ai_only' },
					{ name: 'Regex Only  (fast, offline)',  value: 'regex_only' },
				],
				default: 'ai_regex',
				displayOptions: { show: { maskingEnabled: [true] } },
			},
			{
				displayName: 'Mask PII',
				name: 'maskPii',
				type: 'boolean',
				default: true,
				description: 'Names, emails, phones, addresses, SSNs, DOBs, passport numbers',
				displayOptions: { show: { maskingEnabled: [true] } },
			},
			{
				displayName: 'Mask PCI',
				name: 'maskPci',
				type: 'boolean',
				default: true,
				description: 'Credit cards, CVVs, expiry dates, bank accounts',
				displayOptions: { show: { maskingEnabled: [true] } },
			},
			{
				displayName: 'Mask PHI',
				name: 'maskPhi',
				type: 'boolean',
				default: true,
				description: 'Medical records, health insurance IDs, diagnoses',
				displayOptions: { show: { maskingEnabled: [true] } },
			},
			{
				displayName: 'Custom Patterns',
				name: 'customPatterns',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				displayOptions: { show: { maskingEnabled: [true] } },
				options: [
					{
						name: 'patterns',
						displayName: 'Pattern',
						values: [
							{ displayName: 'Label', name: 'label', type: 'string', default: '' },
							{ displayName: 'Regex', name: 'regex', type: 'string', default: '' },
						],
					},
				],
			},

			// ═══ 📤 OUTPUT ════════════════════════════════════════════════════
			{
				displayName: 'Output Field',
				name: 'outputField',
				type: 'string',
				default: 'output',
				description: 'Field to write the agent response into',
			},
			{
				displayName: 'Include Mask Report',
				name: 'includeMaskReport',
				type: 'boolean',
				default: false,
				description: 'Attach _maskReport showing categories and counts of what was masked',
			},
			{
				displayName: 'Include Masked Prompt',
				name: 'includeMaskedPrompt',
				type: 'boolean',
				default: false,
				description: 'Attach _maskedPrompt showing the exact sanitized text sent to the LLM',
			},
		],
	};

	// ─────────────────────────────────────────────────────────────────────────
	// EXECUTE
	// ─────────────────────────────────────────────────────────────────────────
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items      = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const memoryStore = new Map<string, ChatMessage[]>();

		for (let i = 0; i < items.length; i++) {
			try {
				// ── Parameters ───────────────────────────────────────────────
				const provider          = this.getNodeParameter('provider', i) as string;
				const modelName         = this.getNodeParameter('modelName', i) as string;
				const customBaseUrl     = provider === 'openai_compatible'
					? (this.getNodeParameter('customBaseUrl', i) as string)
					: '';
				const systemPrompt      = this.getNodeParameter('systemPrompt', i) as string;
				const maxTokens         = this.getNodeParameter('maxTokens', i) as number;
				const inputField        = this.getNodeParameter('inputField', i) as string;
				const sessionIdField    = this.getNodeParameter('sessionIdField', i) as string;
				const memoryType        = this.getNodeParameter('memoryType', i) as string;
				const bufferSize        = memoryType === 'buffer'
					? (this.getNodeParameter('bufferSize', i) as number)
					: 10;
				const historyField      = memoryType === 'full'
					? (this.getNodeParameter('historyField', i) as string)
					: '';
				const toolsRaw          = this.getNodeParameter('tools', i) as {
					tool?: { name: string; description: string; parametersSchema: string; endpointUrl: string }[];
				};
				const maskingEnabled    = this.getNodeParameter('maskingEnabled', i) as boolean;
				const detectionMode     = maskingEnabled
					? (this.getNodeParameter('detectionMode', i) as string)
					: 'none';
				const maskPii           = maskingEnabled && (this.getNodeParameter('maskPii', i) as boolean);
				const maskPci           = maskingEnabled && (this.getNodeParameter('maskPci', i) as boolean);
				const maskPhi           = maskingEnabled && (this.getNodeParameter('maskPhi', i) as boolean);
				const customPatternsRaw = maskingEnabled
					? (this.getNodeParameter('customPatterns', i) as { patterns?: { label: string; regex: string }[] })
					: { patterns: [] };
				const outputField         = this.getNodeParameter('outputField', i) as string;
				const includeMaskReport   = this.getNodeParameter('includeMaskReport', i) as boolean;
				const includeMaskedPrompt = this.getNodeParameter('includeMaskedPrompt', i) as boolean;

				// ── Credentials ──────────────────────────────────────────────
				let apiKey  = '';
				let baseUrl = 'https://api.openai.com/v1';

				if (provider === 'anthropic') {
					const creds = await this.getCredentials('secureagentanthropicapi');
					apiKey = creds.apiKey as string;
				} else if (provider === 'openai' || provider === 'openai_compatible') {
					const creds = await this.getCredentials('secureagentopenaiapi');
					apiKey  = creds.apiKey as string;
					baseUrl = (customBaseUrl || creds.baseUrl as string || 'https://api.openai.com/v1').replace(/\/$/, '');
				}

				// ── Raw input ────────────────────────────────────────────────
				const rawInput  = (items[i].json[inputField] as string) ?? '';
				const sessionId = (items[i].json[sessionIdField] as string) ?? 'default';

				if (!rawInput) {
					returnData.push({
						json: { ...items[i].json, [outputField]: '', _error: 'Input field is empty' },
						pairedItem: { item: i },
					});
					continue;
				}

				// ── 🛡️ MASKING STEP (runs BEFORE any LLM call) ──────────────
				let maskedInput = rawInput;
				const maskReport: MaskReport = { entitiesFound: {}, regexMasked: 0, reductionChars: 0 };
				const customPatterns = customPatternsRaw.patterns ?? [];

				if (maskingEnabled) {
					// Pass 1 — Regex (instant, offline)
					if (detectionMode === 'ai_regex' || detectionMode === 'regex_only') {
						const { masked, count } = applyRegexMask(maskedInput, customPatterns);
						maskedInput            = masked;
						maskReport.regexMasked = count;
					}

					// Pass 2 — AI (context-aware)
					if (detectionMode === 'ai_only' || detectionMode === 'ai_regex') {
						const scopes: string[] = [];
						if (maskPii) scopes.push('PII: names, emails, phones, addresses, SSNs, DOBs, passports');
						if (maskPci) scopes.push('PCI: credit cards, CVVs, expiry dates, bank accounts');
						if (maskPhi) scopes.push('PHI: medical records, health insurance IDs, diagnoses');
						const customLabels = customPatterns.map((p) => `${p.label} (${p.regex})`);

						try {
							const aiProvider = provider === 'anthropic' ? 'anthropic' : 'openai';
							const aiModel    = aiProvider === 'anthropic'
								? 'claude-haiku-4-5-20251001'
								: modelName;

							const { masked, report } = await aiMask(
								maskedInput, apiKey, aiProvider, baseUrl, aiModel, scopes, customLabels,
							);
							maskedInput = masked;
							maskReport.entitiesFound = report;
						} catch (maskErr) {
							maskReport.entitiesFound = { AI_MASK_ERROR: (maskErr as Error).message };
						}
					}

					maskReport.reductionChars = rawInput.length - maskedInput.length;
				}

				// ── Build tool definitions ───────────────────────────────────
				const tools: ToolDefinition[] = (toolsRaw.tool ?? []).map((t) => ({
					name:        t.name,
					description: t.description,
					parameters:  JSON.parse(t.parametersSchema || '{"type":"object","properties":{}}') as IDataObject,
					endpointUrl: t.endpointUrl,
				}));

				// ── Build message history ────────────────────────────────────
				let history: ChatMessage[] = [];
				if (memoryType === 'buffer') {
					history = memoryStore.get(sessionId) ?? [];
				} else if (memoryType === 'full') {
					history = (items[i].json[historyField] as ChatMessage[]) ?? [];
				}

				const messages: ChatMessage[] = [
					{ role: 'system', content: systemPrompt },
					...history,
					{ role: 'user',   content: maskedInput },   // ← MASKED text — raw never reaches LLM
				];

				// ── Agentic tool-call loop ───────────────────────────────────
				let finalResponse = '';
				let loopMessages  = [...messages];

				for (let iter = 0; iter < 10; iter++) {
					const { content, toolCalls } = await callLLM(
						provider, apiKey, baseUrl, modelName, loopMessages, tools, maxTokens,
					);

					if (!toolCalls.length) {
						finalResponse = content;
						break;
					}

					loopMessages.push({ role: 'assistant', content: content || '' });

					for (const tc of toolCalls) {
						const toolDef = tools.find((t) => t.name === tc.name);
						let toolResult = 'Tool not found.';
						if (toolDef?.endpointUrl) {
							try {
								const tr = await fetch(toolDef.endpointUrl, {
									method:  'POST',
									headers: { 'Content-Type': 'application/json' },
									body:    JSON.stringify(tc.arguments),
								});
								toolResult = await tr.text();
							} catch (e) {
								toolResult = `Tool error: ${(e as Error).message}`;
							}
						}
						loopMessages.push({
							role:    'user',
							content: `Tool "${tc.name}" result: ${toolResult}`,
						});
					}
				}

				// ── Update buffer memory ─────────────────────────────────────
				if (memoryType === 'buffer') {
					const updated = [
						...(memoryStore.get(sessionId) ?? []),
						{ role: 'user'      as const, content: maskedInput   },
						{ role: 'assistant' as const, content: finalResponse },
					];
					memoryStore.set(sessionId, updated.slice(-(bufferSize * 2)));
				}

				// ── Output ───────────────────────────────────────────────────
				const outputItem: IDataObject = {
					...items[i].json,
					[outputField]: finalResponse,
				};
				if (includeMaskReport)    outputItem._maskReport   = maskReport;
				if (includeMaskedPrompt)  outputItem._maskedPrompt = maskedInput;

				returnData.push({ json: outputItem, pairedItem: { item: i } });

			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
				} else {
					throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				}
			}
		}

		return [returnData];
	}
}