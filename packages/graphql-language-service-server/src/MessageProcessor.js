/**
 *  Copyright (c) Facebook, Inc.
 *  All rights reserved.
 *
 *  This source code is licensed under the license found in the
 *  LICENSE file in the root directory of this source tree.
 *
 *  @flow
 */

import type {Diagnostic, Uri} from 'graphql-language-service-types';

import {findGraphQLConfigDir} from 'graphql-language-service-config';
import {
  getOutline,
  GraphQLLanguageService,
} from 'graphql-language-service-interface';
import {Position} from 'graphql-language-service-utils';
import path from 'path';

import {getGraphQLCache} from './GraphQLCache';

// Response message error codes
const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR_START: -32099,
  SERVER_ERROR_END: -32000,
  SERVER_NOT_INITIALIZED: -32002,
  UNKNOWN_ERROR_CODE: -32001,
};

type RequestMessage = {
  jsonrpc: string,
  id: number | string,
  method: string,
  params?: any,
};

type ResponseMessage = {
  jsonrpc: string,
  id: number | string,
  result?: any,
  error?: ResponseError<any>,
};

type ResponseError<D> = {
  code: number,
  message: string,
  data?: D,
};

type NotificationMessage = {
  jsonrpc: string,
  method: string,
  params?: any,
};

type ServerCapabilities = {
  capabilities: {
    completionProvider: Object,
    textDocumentSync: Object | number,
  },
};

const REQUEST_IDS_IN_PROGRESS = [];

let graphQLCache;
let languageService;
const textDocumentCache: Map<string, Object> = new Map();

export async function processIPCNotificationMessage(
  message: NotificationMessage,
  writer: (message: string) => void,
): Promise<void> {
  const method = message.method;
  let response;
  let textDocument;
  let diagnostics;
  switch (method) {
    case 'textDocument/didOpen':
    case 'textDocument/didSave':
      if (!message.params || !message.params.textDocument) {
        // `textDocument` is required.
        return;
      }
      textDocument = message.params.textDocument;
      const uri = textDocument.uri;

      let text = textDocument.text;

      // Create/modify the cached entry if text is provided.
      // Otherwise, try searching the cache to perform diagnostics.
      if (text) {
        invalidateCache(textDocument, uri, {text});
      } else {
        if (textDocumentCache.has(uri)) {
          const cachedDocument = textDocumentCache.get(uri);
          if (cachedDocument) {
            text = cachedDocument.content.text;
          }
        }
      }

      diagnostics = await provideDiagnosticsMessage(text, uri);
      response = convertToRpcMessage({
        method: 'textDocument/publishDiagnostics',
        params: {uri, diagnostics},
      });
      sendMessageIPC(response, writer);
      break;
    case 'textDocument/didChange':
      // TODO: support onEdit diagnostics
      // For every `textDocument/didChange` event, keep a cache of textDocuments
      // with version information up-to-date, so that the textDocument contents
      // may be used during performing language service features,
      // e.g. autocompletions.
      if (
        !message.params ||
        !message.params.textDocument ||
        !message.params.contentChanges
      ) {
        // `textDocument` and `contentChanges` are required.
        return;
      }

      textDocument = message.params.textDocument;
      const contentChanges = message.params.contentChanges;

      // As `contentChanges` is an array and we just want the
      // latest update to the text, grab the last entry from the array.
      const documentUri = textDocument.uri || message.params.uri;
      invalidateCache(
        textDocument,
        documentUri,
        contentChanges[contentChanges.length - 1],
      );

      // Send the diagnostics onChange as well
      diagnostics = await provideDiagnosticsMessage(
        textDocumentCache.get(documentUri),
        documentUri,
      );
      response = convertToRpcMessage({
        method: 'textDocument/publishDiagnostics',
        params: {documentUri, diagnostics},
      });
      sendMessageIPC(response, writer);
      break;
    case 'textDocument/didClose':
      // For every `textDocument/didClose` event, delete the cached entry.
      // This is to keep a low memory usage && switch the source of truth to
      // the file on disk.
      if (!message.params || !message.params.textDocument) {
        // `textDocument` is required.
        return;
      }
      textDocument = message.params.textDocument;

      if (textDocumentCache.has(textDocument.uri)) {
        textDocumentCache.delete(textDocument.uri);
      }
      break;
    case 'exit':
      process.exit(0);
      break;
  }
}

export async function processIPCRequestMessage(
  message: RequestMessage,
  configDir: ?string,
  writer: (message: string) => void,
): Promise<void> {
  const method = message.method;
  let response;
  let textDocument;
  let cachedDocument;
  let query;
  let result;
  switch (method) {
    case 'initialize':
      if (!message.params || !message.params.rootPath) {
        // `rootPath` is required
        return;
      }
      const serverCapabilities = await initialize(
        configDir ? configDir.trim() : message.params.rootPath,
      );

      if (serverCapabilities === null) {
        response = convertToRpcMessage({
          id: '-1',
          error: {
            code: ERROR_CODES.SERVER_NOT_INITIALIZED,
            message: '.graphqlrc not found',
          },
        });
      } else {
        response = convertToRpcMessage({
          id: message.id,
          result: serverCapabilities,
        });
      }
      sendMessageIPC(response, writer);
      break;
    case 'textDocument/completion':
      // `textDocument/comletion` event takes advantage of the fact that
      // `textDocument/didChange` event always fires before, which would have
      // updated the cache with the query text from the editor.
      // Treat the computed list always complete.
      // (response: Array<CompletionItem>)
      if (
        !message.params ||
        !message.params.textDocument ||
        !message.params.position
      ) {
        // `textDocument` is required.
        return;
      }
      textDocument = message.params.textDocument;
      const position = message.params.position;

      cachedDocument = getCachedDocument(textDocument.uri);
      if (!cachedDocument) {
        // `cachedDocument` is required.
        return;
      }

      query = cachedDocument.content.text;
      result = await languageService.getAutocompleteSuggestions(
        query,
        position,
        textDocument.uri,
      );
      sendMessageIPC(
        convertToRpcMessage({
          id: message.id,
          result: {items: result, isCompleted: true},
        }),
        writer,
      );
      break;
    case 'textDocument/definition':
      if (
        !message.params ||
        !message.params.textDocument ||
        !message.params.position
      ) {
        // `textDocument` is required.
        return;
      }
      textDocument = message.params.textDocument;
      const pos = message.params.position;

      cachedDocument = getCachedDocument(textDocument.uri);
      if (!cachedDocument) {
        // `cachedDocument` is required.
        return;
      }

      query = cachedDocument.content.text;
      result = await languageService.getDefinition(
        query,
        pos,
        textDocument.uri,
      );
      const formatted = result
        ? result.definitions.map(res => ({
            uri: path.join('file://', res.path),
            range: res.range,
          }))
        : [];
      sendMessageIPC(
        convertToRpcMessage({
          id: message.id,
          result: formatted,
        }),
        writer,
      );
      break;
    case '$/cancelRequest':
      if (!message.params || !message.params.id) {
        // `id` is required.
        return;
      }
      const requestIDToCancel = message.params.id;
      const index = REQUEST_IDS_IN_PROGRESS.indexOf(requestIDToCancel);
      if (index !== -1) {
        REQUEST_IDS_IN_PROGRESS.splice(index, 1);
        // A cancelled request still needs to send an empty response back
        sendMessageIPC({id: requestIDToCancel}, writer);
      }
      break;
    case 'shutdown':
      // prepare to shut down the server
      break;
  }
}

export async function processStreamMessage(
  message: string,
  configDir: ?string,
): Promise<void> {
  if (message.length === 0) {
    return;
  }
  if (!graphQLCache) {
    const graphQLConfigDir = findGraphQLConfigDir(
      configDir ? configDir.trim() : process.cwd(),
    );
    if (!graphQLConfigDir) {
      process.stdout.write(
        JSON.stringify(
          convertToRpcMessage({
            id: '-1',
            error: {
              code: ERROR_CODES.SERVER_NOT_INITIALIZED,
              message: '.graphqlrc not found',
            },
          }),
        ),
      );
      return;
    }
    graphQLCache = await getGraphQLCache(graphQLConfigDir);
  }
  if (!languageService) {
    languageService = new GraphQLLanguageService(graphQLCache);
  }

  let json;

  try {
    json = JSON.parse(message);
  } catch (error) {
    process.stdout.write(
      JSON.stringify(
        convertToRpcMessage({
          id: '-1',
          error: {
            code: ERROR_CODES.PARSE_ERROR,
            message: 'Request contains incorrect JSON format',
          },
        }),
      ),
    );
    return;
  }

  const id = json.id;
  const method = json.method;

  let result = null;
  let responseMsg = null;

  const {query, filePath, position} = json.args;

  switch (method) {
    case 'disconnect':
      process.exit(0);
      break;
    case 'getDiagnostics':
      result = await provideDiagnosticsMessage(query, filePath);
      responseMsg = convertToRpcMessage({
        type: 'response',
        id,
        result,
      });
      process.stdout.write(JSON.stringify(responseMsg) + '\n');
      break;
    case 'getDefinition':
      result = await languageService.getDefinition(query, position, filePath);
      responseMsg = convertToRpcMessage({
        type: 'response',
        id,
        result,
      });
      process.stdout.write(JSON.stringify(responseMsg) + '\n');
      break;
    case 'getAutocompleteSuggestions':
      result = await languageService.getAutocompleteSuggestions(
        query,
        position,
        filePath,
      );

      const formatted = result.map(res => ({
        text: res.label,
        typeName: res.detail ? String(res.detail) : null,
        description: res.documentation || null,
      }));
      responseMsg = convertToRpcMessage({
        type: 'response',
        id,
        formatted,
      });
      process.stdout.write(JSON.stringify(responseMsg) + '\n');
      break;
    case 'getOutline':
      result = getOutline(query);
      responseMsg = convertToRpcMessage({
        type: 'response',
        id,
        result,
      });
      process.stdout.write(JSON.stringify(responseMsg) + '\n');
      break;
    default:
      break;
  }
}

/**
 * Helper functions to perform requested services from client/server.
 */

async function initialize(rootPath: Uri): Promise<?ServerCapabilities> {
  const serverCapabilities = {
    capabilities: {
      completionProvider: {resolveProvider: true},
      definitionProvider: true,
      textDocumentSync: 1,
    },
  };

  const configDir = findGraphQLConfigDir(rootPath);
  if (!configDir) {
    return null;
  }

  graphQLCache = await getGraphQLCache(configDir);
  languageService = new GraphQLLanguageService(graphQLCache);

  return serverCapabilities;
}

async function provideDiagnosticsMessage(
  query: string,
  uri: Uri,
): Promise<Array<Diagnostic>> {
  let results = await languageService.getDiagnostics(query, uri);
  if (results && results.length > 0) {
    const queryLines = query.split('\n');
    const totalLines = queryLines.length;
    const lastLineLength = queryLines[totalLines - 1].length;
    const lastCharacterPosition = new Position(totalLines, lastLineLength);
    results = results.filter(diagnostic =>
      diagnostic.range.end.lessThanOrEqualTo(lastCharacterPosition));
  }

  return results;
}

function sendMessageIPC(message: any, writer: (message: string) => void): void {
  writer.write(message);
}

/**
 * Composes a language server protocol JSON message.
 */
function convertToRpcMessage(metaMessage: Object): ResponseMessage {
  const message: ResponseMessage = {
    jsonrpc: '2.0',
    protocol: 'graphql_language_service',
    ...metaMessage,
  };

  return message;
}

function invalidateCache(
  textDocument: Object,
  uri: Uri,
  content: Object,
): void {
  if (!uri) {
    return;
  }

  if (textDocumentCache.has(uri)) {
    const cachedDocument = textDocumentCache.get(uri);
    if (cachedDocument && cachedDocument.version < textDocument.version) {
      // Current server capabilities specify the full sync of the contents.
      // Therefore always overwrite the entire content.
      textDocumentCache.set(uri, {
        version: textDocument.version,
        content,
      });
    }
  } else {
    textDocumentCache.set(uri, {
      version: textDocument.version,
      content,
    });
  }
}

function getCachedDocument(uri: string): ?Object {
  if (textDocumentCache.has(uri)) {
    const cachedDocument = textDocumentCache.get(uri);
    if (cachedDocument) {
      return cachedDocument;
    }
  }

  return null;
}
