import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class Secureagentopenaiapi implements ICredentialType {
	name = 'secureagentopenaiapi';
	displayName = 'Secure Agent — OpenAI API';
	documentationUrl = 'https://platform.openai.com/docs/api-reference';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName: 'Base URL (optional)',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.openai.com/v1',
			description: 'Override for custom OpenAI-compatible endpoints (Azure, Groq, Together, etc.)',
		},
	];
}