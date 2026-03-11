import * as lark from '@larksuiteoapi/node-sdk';

export interface FeishuWikiSpace {
  id: string;
  name: string;
  description?: string;
  visibility?: string;
  spaceType?: string;
}

export interface FeishuWikiSearchHit {
  title: string;
  spaceId: string;
  nodeId: string;
  objToken: string;
  url?: string;
}

export interface FeishuWikiReadResult {
  title?: string;
  spaceId?: string;
  nodeToken?: string;
  objToken?: string;
  objType?: string;
  url?: string;
  content?: string;
}

export interface FeishuWikiCreateResult {
  title?: string;
  spaceId?: string;
  nodeToken?: string;
  objToken?: string;
  objType?: string;
}

export interface FeishuWikiSpaceMember {
  memberType: string;
  memberId: string;
  memberRole: string;
  type?: string;
}

export class FeishuWikiClient {
  public constructor(private readonly client: lark.Client) {}

  public async listSpaces(limit: number = 20): Promise<FeishuWikiSpace[]> {
    const results: FeishuWikiSpace[] = [];
    let pageToken: string | undefined;

    while (results.length < limit) {
      const response = await this.client.wiki.v2.space.list({
        params: {
          page_size: Math.min(50, limit - results.length),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      ensureSuccess(response);
      const items = response.data?.items ?? [];
      for (const item of items) {
        if (!item.space_id || !item.name) {
          continue;
        }
        results.push({
          id: item.space_id,
          name: item.name,
          description: item.description,
          visibility: item.visibility,
          spaceType: item.space_type,
        });
      }

      if (!response.data?.has_more || !response.data.page_token) {
        break;
      }
      pageToken = response.data.page_token;
    }

    return results;
  }

  public async search(query: string, spaceIds: string[] = [], limit: number = 5): Promise<FeishuWikiSearchHit[]> {
    const spaces = spaceIds.length > 0 ? spaceIds : [undefined];
    const hits: FeishuWikiSearchHit[] = [];
    const seen = new Set<string>();

    for (const spaceId of spaces) {
      const response = await this.client.wiki.v1.node.search({
        data: {
          query,
          ...(spaceId ? { space_id: spaceId } : {}),
        },
        params: {
          page_size: limit,
        },
      });
      ensureSuccess(response);
      for (const item of response.data?.items ?? []) {
        if (!item.obj_token || !item.title || !item.node_id || !item.space_id) {
          continue;
        }
        if (seen.has(item.obj_token)) {
          continue;
        }
        seen.add(item.obj_token);
        hits.push({
          title: item.title,
          spaceId: item.space_id,
          nodeId: item.node_id,
          objToken: item.obj_token,
          url: item.url,
        });
        if (hits.length >= limit) {
          return hits;
        }
      }
    }

    return hits;
  }

  public async read(target: string): Promise<FeishuWikiReadResult> {
    const parsed = parseWikiTarget(target);

    if (parsed.kind === 'docx') {
      return this.readDocx(parsed.token);
    }

    const nodeResponse = await this.client.wiki.v2.space.getNode({
      params: {
        token: parsed.token,
      },
    });
    ensureSuccess(nodeResponse);
    const node = nodeResponse.data?.node;
    if (!node) {
      throw new Error('Feishu wiki node not found.');
    }

    const result: FeishuWikiReadResult = {
      title: node.title,
      spaceId: node.space_id,
      nodeToken: node.node_token,
      objToken: node.obj_token,
      objType: node.obj_type,
      url: parsed.url,
    };

    if (node.obj_type === 'docx' && node.obj_token) {
      const doc = await this.readDocx(node.obj_token);
      return {
        ...result,
        ...doc,
      };
    }

    return result;
  }

  public async createDoc(spaceId: string, title: string, parentNodeToken?: string): Promise<FeishuWikiCreateResult> {
    const response = await this.client.wiki.v2.spaceNode.create({
      path: {
        space_id: spaceId,
      },
      data: {
        obj_type: 'docx',
        node_type: 'origin',
        ...(parentNodeToken ? { parent_node_token: parentNodeToken } : {}),
        title,
      },
    });
    ensureSuccess(response);
    const node = response.data?.node;
    return {
      title: node?.title ?? title,
      spaceId: node?.space_id ?? spaceId,
      nodeToken: node?.node_token,
      objToken: node?.obj_token,
      objType: node?.obj_type,
    };
  }

  public async renameNode(nodeToken: string, title: string, spaceId?: string): Promise<void> {
    const response = await this.client.wiki.v2.spaceNode.updateTitle({
      path: {
        ...(spaceId ? { space_id: spaceId } : {}),
        node_token: nodeToken,
      },
      data: {
        title,
      },
    });
    ensureSuccess(response);
  }

  public async copyNode(nodeToken: string, targetSpaceId: string, sourceSpaceId?: string): Promise<FeishuWikiCreateResult> {
    const response = await this.client.wiki.v2.spaceNode.copy({
      path: {
        ...(sourceSpaceId ? { space_id: sourceSpaceId } : {}),
        node_token: nodeToken,
      },
      data: {
        target_space_id: targetSpaceId,
      },
    });
    ensureSuccess(response);
    const node = response.data?.node;
    return {
      title: node?.title,
      spaceId: node?.space_id ?? targetSpaceId,
      nodeToken: node?.node_token,
      objToken: node?.obj_token,
      objType: node?.obj_type,
    };
  }

  public async moveNode(sourceSpaceId: string, nodeToken: string, targetSpaceId: string): Promise<FeishuWikiCreateResult> {
    const response = await this.client.wiki.v2.spaceNode.move({
      path: {
        space_id: sourceSpaceId,
        node_token: nodeToken,
      },
      data: {
        target_space_id: targetSpaceId,
      },
    });
    ensureSuccess(response);
    const node = response.data?.node;
    return {
      title: node?.title,
      spaceId: node?.space_id ?? targetSpaceId,
      nodeToken: node?.node_token,
      objToken: node?.obj_token,
      objType: node?.obj_type,
    };
  }

  public async listMembers(spaceId: string, limit: number = 20): Promise<FeishuWikiSpaceMember[]> {
    const results: FeishuWikiSpaceMember[] = [];
    let pageToken: string | undefined;

    while (results.length < limit) {
      const response = await this.client.wiki.v2.spaceMember.list({
        path: {
          space_id: spaceId,
        },
        params: {
          page_size: Math.min(50, limit - results.length),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      ensureSuccess(response);
      const members = response.data?.members ?? [];
      for (const member of members) {
        if (!member.member_id || !member.member_type || !member.member_role) {
          continue;
        }
        results.push({
          memberId: member.member_id,
          memberType: member.member_type,
          memberRole: member.member_role,
          type: member.type,
        });
      }

      if (!response.data?.has_more || !response.data.page_token) {
        break;
      }
      pageToken = response.data.page_token;
    }

    return results;
  }

  public async addMember(spaceId: string, memberType: string, memberId: string, memberRole: string = 'member', needNotification: boolean = false): Promise<FeishuWikiSpaceMember> {
    const response = await this.client.wiki.v2.spaceMember.create({
      path: {
        space_id: spaceId,
      },
      params: {
        need_notification: needNotification,
      },
      data: {
        member_type: memberType,
        member_id: memberId,
        member_role: memberRole,
      },
    });
    ensureSuccess(response);
    const member = response.data?.member;
    return {
      memberId: member?.member_id ?? memberId,
      memberType: member?.member_type ?? memberType,
      memberRole: member?.member_role ?? memberRole,
      type: member?.type,
    };
  }

  public async removeMember(spaceId: string, memberType: string, memberId: string, memberRole: string = 'member'): Promise<FeishuWikiSpaceMember> {
    const response = await this.client.wiki.v2.spaceMember.delete({
      path: {
        space_id: spaceId,
        member_id: memberId,
      },
      data: {
        member_type: memberType,
        member_role: memberRole,
      },
    });
    ensureSuccess(response);
    const member = response.data?.member;
    return {
      memberId: member?.member_id ?? memberId,
      memberType: member?.member_type ?? memberType,
      memberRole: member?.member_role ?? memberRole,
      type: member?.type,
    };
  }

  private async readDocx(documentId: string): Promise<FeishuWikiReadResult> {
    const [metaResponse, contentResponse] = await Promise.all([
      this.client.docx.v1.document.get({
        path: {
          document_id: documentId,
        },
      }),
      this.client.docx.v1.document.rawContent({
        path: {
          document_id: documentId,
        },
      }),
    ]);
    ensureSuccess(metaResponse);
    ensureSuccess(contentResponse);
    return {
      title: metaResponse.data?.document?.title,
      objToken: documentId,
      objType: 'docx',
      content: contentResponse.data?.content,
    };
  }
}

function ensureSuccess(response: { code?: number; msg?: string }): void {
  if (response.code === undefined || response.code === 0) {
    return;
  }
  throw new Error(`Feishu API error ${response.code}: ${response.msg ?? 'unknown error'}`);
}

function parseWikiTarget(target: string): { kind: 'docx' | 'wiki'; token: string; url?: string } {
  const trimmed = target.trim();
  const docxMatch = trimmed.match(/\/docx\/([A-Za-z0-9]+)/i);
  if (docxMatch?.[1]) {
    return { kind: 'docx', token: docxMatch[1], url: trimmed };
  }

  const wikiMatch = trimmed.match(/\/wiki\/([A-Za-z0-9]+)/i);
  if (wikiMatch?.[1]) {
    return { kind: 'wiki', token: wikiMatch[1], url: trimmed };
  }

  if (/^dox[A-Za-z0-9]+$/i.test(trimmed)) {
    return { kind: 'docx', token: trimmed };
  }

  return { kind: 'wiki', token: trimmed };
}
