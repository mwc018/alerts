import axios from 'axios';
import config from '../config/config.js';

interface ZohoTokenResponse {
  access_token: string;
  expires_in: number;
}

export interface ZohoTicket {
  id: string;
  ticketNumber: string;
  subject: string;
  status: string;
}

interface ZohoContact {
  id: string;
  email: string;
}

let tokenCache: { access_token: string; expires_at: number } | null = null;

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expires_at > now + 5 * 60 * 1000) {
    return tokenCache.access_token;
  }

  const { clientId, clientSecret, refreshToken } = config.zoho;
  const response = await axios.post<ZohoTokenResponse>(
    'https://accounts.zoho.com/oauth/v2/token',
    null,
    {
      params: {
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      },
    }
  );

  tokenCache = {
    access_token: response.data.access_token,
    expires_at: now + response.data.expires_in * 1000,
  };

  return tokenCache.access_token;
}

async function getHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    Authorization: `Zoho-oauthtoken ${token}`,
    orgId: config.zoho.orgId,
    'Content-Type': 'application/json',
  };
}

async function findOrCreateContact(email: string, name: string): Promise<string> {
  const headers = await getHeaders();

  // Try to find existing contact
  try {
    const search = await axios.get<{ data: ZohoContact[] }>(
      `${config.zoho.baseUrl}/api/v1/contacts/search`,
      { headers, params: { email } }
    );
    const contacts = search.data?.data || (search.data as any) || [];
    if (Array.isArray(contacts) && contacts.length > 0) {
      return contacts[0].id;
    }
  } catch {
    // fall through to create
  }

  // Create new contact
  const nameParts = name.trim().split(' ');
  const firstName = nameParts[0] || name;
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : 'Support';

  const create = await axios.post<ZohoContact>(
    `${config.zoho.baseUrl}/api/v1/contacts`,
    { email, firstName, lastName },
    { headers }
  );

  return create.data.id;
}

export async function createTicket(params: {
  subject: string;
  description: string;
  contactEmail?: string;
  contactName?: string;
  priority?: 'High' | 'Medium' | 'Low';
  status?: string;
  accountId?: string;
}): Promise<ZohoTicket> {
  try {
    const headers = await getHeaders();

    const ticketData: Record<string, unknown> = {
      subject: params.subject,
      description: params.description,
      departmentId: config.zoho.departmentId,
      priority: params.priority || 'Medium',
      status: params.status || 'Open',
    };

    if (params.contactEmail && params.contactName) {
      const contactId = await findOrCreateContact(params.contactEmail, params.contactName);
      ticketData.contactId = contactId;
    }

    if (params.accountId) {
      ticketData.accountId = params.accountId;
    }

    const response = await axios.post<ZohoTicket>(
      `${config.zoho.baseUrl}/api/v1/tickets`,
      ticketData,
      { headers }
    );

    console.log(`Created Zoho ticket: ${response.data.ticketNumber}`);
    return response.data;
  } catch (error: any) {
    console.error('Error creating Zoho ticket:', error.response?.data || error.message);
    throw new Error(`Failed to create Zoho ticket: ${error.response?.data?.message || error.message}`);
  }
}

export async function closeTicket(ticketId: string): Promise<void> {
  try {
    const headers = await getHeaders();
    await axios.patch(
      `${config.zoho.baseUrl}/api/v1/tickets/${ticketId}`,
      { status: 'Closed' },
      { headers }
    );
    console.log(`Closed Zoho ticket: ${ticketId}`);
  } catch (error: any) {
    console.error('Error closing Zoho ticket:', error.response?.data || error.message);
    throw new Error(`Failed to close Zoho ticket: ${error.response?.data?.message || error.message}`);
  }
}

export async function addTicketComment(
  ticketId: string,
  comment: string,
  isPublic = false
): Promise<void> {
  try {
    const headers = await getHeaders();
    await axios.post(
      `${config.zoho.baseUrl}/api/v1/tickets/${ticketId}/comments`,
      { content: comment, isPublic },
      { headers }
    );
    console.log(`Added comment to Zoho ticket: ${ticketId}`);
  } catch (error: any) {
    console.error('Error adding comment to Zoho ticket:', error.response?.data || error.message);
    throw new Error(`Failed to add comment to Zoho ticket: ${error.response?.data?.message || error.message}`);
  }
}
