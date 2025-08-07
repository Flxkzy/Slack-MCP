#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { WebClient } from '@slack/web-api';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Types
interface SlackToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

interface ToolArguments {
  [key: string]: any;
}

// Initialize Slack client
const slackToken = process.env.SLACK_BOT_TOKEN;
if (!slackToken) {
  console.error('❌ SLACK_BOT_TOKEN is required. Please check your .env file.');
  process.exit(1);
}

if (!slackToken.startsWith('xoxb-')) {
  console.error('❌ SLACK_BOT_TOKEN must be a bot token (starts with xoxb-)');
  process.exit(1);
}

const slack = new WebClient(slackToken);

// Helper function to resolve channel ID from name
async function resolveChannelId(channelInput: string): Promise<string> {
  if (channelInput.startsWith('C') || channelInput.startsWith('D') || channelInput.startsWith('G')) {
    return channelInput;
  }

  const channelName = channelInput.startsWith('#') ? channelInput.slice(1) : channelInput;

  try {
    const result = await slack.conversations.list({
      types: 'public_channel,private_channel',
      limit: 1000
    });

    const channel = result.channels?.find(ch => ch.name === channelName);
    if (channel?.id) {
      return channel.id;
    }

    throw new Error(`Channel '${channelInput}' not found`);
  } catch (error) {
    throw new Error(`Failed to resolve channel '${channelInput}': ${error}`);
  }
}

// Helper function to resolve user ID from name
async function resolveUserId(userInput: string): Promise<string> {
  if (userInput.startsWith('U') || userInput.startsWith('W')) {
    return userInput;
  }

  const userName = userInput.startsWith('@') ? userInput.slice(1) : userInput;

  try {
    const result = await slack.users.list({});
    const user = result.members?.find(u => 
      u.name === userName || 
      u.real_name === userName || 
      u.profile?.display_name === userName
    );

    if (user?.id) {
      return user.id;
    }

    throw new Error(`User '${userInput}' not found`);
  } catch (error) {
    throw new Error(`Failed to resolve user '${userInput}': ${error}`);
  }
}

// Tool Functions
async function sendMessage(args: ToolArguments): Promise<SlackToolResult> {
  try {
    const { channel, text, thread_ts } = args;

    if (!channel || !text) {
      return { success: false, error: 'Both channel and text are required' };
    }

    const channelId = await resolveChannelId(channel);

    const result = await slack.chat.postMessage({
      channel: channelId,
      text: text,
      thread_ts: thread_ts || undefined,
      unfurl_links: true,
      unfurl_media: true
    });

    if (result.ok) {
      return {
        success: true,
        data: {
          channel: result.channel,
          ts: result.ts,
          message: result.message
        }
      };
    } else {
      return { success: false, error: result.error || 'Failed to send message' };
    }
  } catch (error) {
    return { success: false, error: `Error sending message: ${error}` };
  }
}

async function listChannels(args: ToolArguments): Promise<SlackToolResult> {
  try {
    const { 
      types = 'public_channel,private_channel', 
      exclude_archived = true,
      limit = 100 
    } = args;

    const result = await slack.conversations.list({
      types: types,
      exclude_archived: exclude_archived,
      limit: limit
    });

    if (result.ok && result.channels) {
      const channels = result.channels.map(channel => ({
        id: channel.id,
        name: channel.name,
        is_private: channel.is_private,
        is_member: channel.is_member,
        is_archived: channel.is_archived,
        num_members: channel.num_members,
        topic: channel.topic?.value || '',
        purpose: channel.purpose?.value || ''
      }));

      return {
        success: true,
        data: { channels: channels, total: channels.length }
      };
    } else {
      return { success: false, error: result.error || 'Failed to list channels' };
    }
  } catch (error) {
    return { success: false, error: `Error listing channels: ${error}` };
  }
}

async function getChannelHistory(args: ToolArguments): Promise<SlackToolResult> {
  try {
    const { 
      channel, 
      limit = 20, 
      oldest, 
      latest,
      include_all_metadata = false 
    } = args;

    if (!channel) {
      return { success: false, error: 'Channel is required' };
    }

    const channelId = await resolveChannelId(channel);

    const result = await slack.conversations.history({
      channel: channelId,
      limit: limit,
      oldest: oldest,
      latest: latest,
      include_all_metadata: include_all_metadata
    });

    if (result.ok && result.messages) {
      const messages = result.messages.map(msg => ({
        type: msg.type,
        user: msg.user,
        username: msg.username,
        text: msg.text || '',
        ts: msg.ts || '',
        thread_ts: msg.thread_ts,
        reply_count: msg.reply_count || 0,
        reactions: msg.reactions || [],
        files: msg.files || [],
        attachments: msg.attachments || []
      }));

      return {
        success: true,
        data: {
          messages: messages,
          has_more: result.has_more,
          channel_id: channelId
        }
      };
    } else {
      return { success: false, error: result.error || 'Failed to get channel history' };
    }
  } catch (error) {
    return { success: false, error: `Error getting channel history: ${error}` };
  }
}

async function searchMessages(args: ToolArguments): Promise<SlackToolResult> {
  try {
    const { 
      query, 
      sort = 'timestamp',
      sort_dir = 'desc',
      count = 20,
      page = 1,
      channel 
    } = args;

    if (!query) {
      return { success: false, error: 'Search query is required' };
    }

    let searchQuery = query;
    
    if (channel) {
      const channelId = await resolveChannelId(channel);
      searchQuery = `${query} in:<#${channelId}>`;
    }

    const result = await slack.search.messages({
      query: searchQuery,
      sort: sort,
      sort_dir: sort_dir,
      count: count,
      page: page
    });

    if (result.ok && result.messages) {
      const messages = result.messages.matches?.map(msg => ({
        type: msg.type,
        user: msg.user,
        username: msg.username,
        text: msg.text || '',
        ts: msg.ts || '',
        channel: msg.channel,
        permalink: msg.permalink
      })) || [];

      return {
        success: true,
        data: {
          messages: messages,
          total: result.messages.total || 0,
          page: page,
          per_page: count
        }
      };
    } else {
      return { success: false, error: result.error || 'Search failed' };
    }
  } catch (error) {
    return { success: false, error: `Error searching messages: ${error}` };
  }
}

async function getUserInfo(args: ToolArguments): Promise<SlackToolResult> {
  try {
    const { user } = args;

    if (!user) {
      return { success: false, error: 'User is required' };
    }

    const userId = await resolveUserId(user);

    const result = await slack.users.info({ user: userId });

    if (result.ok && result.user) {
      const userInfo = {
        id: result.user.id,
        name: result.user.name,
        real_name: result.user.real_name || '',
        display_name: result.user.profile?.display_name || '',
        email: result.user.profile?.email,
        is_bot: result.user.is_bot || false,
        is_admin: result.user.is_admin || false,
        is_owner: result.user.is_owner || false,
        profile: {
          real_name: result.user.profile?.real_name || '',
          display_name: result.user.profile?.display_name || '',
          email: result.user.profile?.email,
          image_192: result.user.profile?.image_192 || '',
          status_text: result.user.profile?.status_text || '',
          status_emoji: result.user.profile?.status_emoji || '',
          title: result.user.profile?.title || '',
          phone: result.user.profile?.phone || ''
        },
        tz: result.user.tz,
        tz_label: result.user.tz_label,
        tz_offset: result.user.tz_offset
      };

      return { success: true, data: userInfo };
    } else {
      return { success: false, error: result.error || 'Failed to get user info' };
    }
  } catch (error) {
    return { success: false, error: `Error getting user info: ${error}` };
  }
}

async function listUsers(args: ToolArguments): Promise<SlackToolResult> {
  try {
    const { limit = 50, cursor } = args;

    const result = await slack.users.list({
      limit: limit,
      cursor: cursor
    });

    if (result.ok && result.members) {
      const users = result.members
        .filter(user => !user.deleted && !user.is_bot)
        .map(user => ({
          id: user.id,
          name: user.name,
          real_name: user.real_name || '',
          display_name: user.profile?.display_name || '',
          email: user.profile?.email,
          is_admin: user.is_admin || false,
          is_owner: user.is_owner || false,
          status_text: user.profile?.status_text || '',
          status_emoji: user.profile?.status_emoji || ''
        }));

      return {
        success: true,
        data: {
          users: users,
          response_metadata: result.response_metadata
        }
      };
    } else {
      return { success: false, error: result.error || 'Failed to list users' };
    }
  } catch (error) {
    return { success: false, error: `Error listing users: ${error}` };
  }
}

// Test Slack connection
async function testSlackConnection(): Promise<boolean> {
  try {
    const response = await slack.auth.test();
    console.error('✅ Slack connection successful:', response.user);
    return true;
  } catch (error) {
    console.error('❌ Slack connection failed:', error);
    return false;
  }
}

// Tool definitions
const tools = [
  {
    name: 'slack_send_message',
    description: 'Send a message to a Slack channel or direct message',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel name (with or without #) or channel ID. For DMs, use @username or user ID.'
        },
        text: {
          type: 'string',
          description: 'The message text to send. Supports Slack markdown formatting.'
        },
        thread_ts: {
          type: 'string',
          description: 'Optional: timestamp of parent message to reply in thread'
        }
      },
      required: ['channel', 'text']
    }
  },
  {
    name: 'slack_list_channels',
    description: 'List Slack channels that the bot has access to',
    inputSchema: {
      type: 'object',
      properties: {
        types: {
          type: 'string',
          description: 'Channel types to include: public_channel, private_channel, mpim, im',
          default: 'public_channel,private_channel'
        },
        exclude_archived: {
          type: 'boolean',
          description: 'Whether to exclude archived channels',
          default: true
        },
        limit: {
          type: 'number',
          description: 'Maximum number of channels to return',
          default: 100
        }
      },
      required: []
    }
  },
  {
    name: 'slack_get_channel_history',
    description: 'Get recent messages from a Slack channel',
    inputSchema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel name (with or without #) or channel ID'
        },
        limit: {
          type: 'number',
          description: 'Number of messages to retrieve (max 1000)',
          default: 20,
          maximum: 1000
        },
        oldest: {
          type: 'string',
          description: 'Start of time range (Unix timestamp)'
        },
        latest: {
          type: 'string',
          description: 'End of time range (Unix timestamp)'
        },
        include_all_metadata: {
          type: 'boolean',
          description: 'Include all metadata in response',
          default: false
        }
      },
      required: ['channel']
    }
  },
  {
    name: 'slack_search_messages',
    description: 'Search for messages across Slack channels',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Supports Slack search syntax (e.g., "from:@user", "before:2024-01-01")'
        },
        channel: {
          type: 'string',
          description: 'Optional: limit search to specific channel (name or ID)'
        },
        sort: {
          type: 'string',
          description: 'Sort results by: timestamp, score',
          default: 'timestamp'
        },
        sort_dir: {
          type: 'string',
          description: 'Sort direction: asc, desc',
          default: 'desc'
        },
        count: {
          type: 'number',
          description: 'Number of results to return (max 100)',
          default: 20,
          maximum: 100
        },
        page: {
          type: 'number',
          description: 'Page number for pagination',
          default: 1
        }
      },
      required: ['query']
    }
  },
  {
    name: 'slack_get_user_info',
    description: 'Get information about a specific Slack user',
    inputSchema: {
      type: 'object',
      properties: {
        user: {
          type: 'string',
          description: 'Username (with or without @) or user ID'
        }
      },
      required: ['user']
    }
  },
  {
    name: 'slack_list_users',
    description: 'List users in the Slack workspace',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of users to return',
          default: 50
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor for getting next page of results'
        }
      },
      required: []
    }
  }
];

// Create server instance
const server = new Server(
  {
    name: 'slack-mcp-server',
    version: '1.0.0',
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: SlackToolResult;

    switch (name) {
      case 'slack_send_message':
        result = await sendMessage(args || {});
        break;
      case 'slack_list_channels':
        result = await listChannels(args || {});
        break;
      case 'slack_get_channel_history':
        result = await getChannelHistory(args || {});
        break;
      case 'slack_search_messages':
        result = await searchMessages(args || {});
        break;
      case 'slack_get_user_info':
        result = await getUserInfo(args || {});
        break;
      case 'slack_list_users':
        result = await listUsers(args || {});
        break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    if (result.success) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    } else {
      throw new McpError(ErrorCode.InternalError, result.error || 'Tool execution failed');
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    
    throw new McpError(ErrorCode.InternalError, `Tool execution error: ${error}`);
  }
});

// Start the server
async function main() {
  try {
    console.error('🚀 Starting Slack MCP Server...');
    const connectionOk = await testSlackConnection();
    
    if (!connectionOk) {
      console.error('❌ Failed to connect to Slack. Check your SLACK_BOT_TOKEN.');
      process.exit(1);
    }

    console.error('✅ Slack MCP Server started successfully!');
    console.error('📋 Available tools:', tools.map(t => t.name).join(', '));

    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    console.error('❌ Server startup failed:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.error('\n👋 Shutting down Slack MCP Server...');
  await server.close();
  process.exit(0);
});

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});