import * as WebSocket from 'ws';

import MessageTypes from './message-types';
import { GRAPHQL_WS } from './protocol';
import isObject from './utils/is-object';
import {
  ExecutionResult,
  GraphQLSchema,
  DocumentNode,
  ValidationContext,
  specifiedRules,
  GraphQLFieldResolver,
  Source,
  ParseOptions,
} from 'graphql';
import { createEmptyIterable } from './utils/empty-iterable';
import { createAsyncIterator, forAwaitEach, isAsyncIterable } from 'iterall';
import { isASubscriptionOperation } from './utils/is-subscriptions';
import { parseLegacyProtocolMessage } from './legacy/parse-legacy-protocol';
import { IncomingMessage } from 'http';

import type {
  validate as defaultValidate,
  execute as defaultExecute,
} from 'graphql';

export type ExecutionIterator = AsyncIterator<ExecutionResult>;

export interface ExecutionParams<TContext = any> {
  query: string | DocumentNode;
  variables: { [key: string]: any };
  operationName: string;
  context: TContext;
  formatResponse?: Function;
  formatError?: Function;
  callback?: Function;
  schema: GraphQLSchema;
  validate: typeof defaultValidate;
  parse: ParseType;
}

export type ConnectionContext = {
  initPromise?: Promise<OnConnectResult>;
  isLegacy: boolean;
  socket: WebSocket;
  request: IncomingMessage;
  operations: {
    [opId: string]: ExecutionIterator;
  };
};

export interface OperationMessagePayload {
  [key: string]: any; // this will support for example any options sent in init like the auth token
  query?: string;
  variables?: { [key: string]: any };
  operationName?: string;
}

export interface OperationMessage {
  payload?: OperationMessagePayload;
  id?: string;
  type: string;
}

export type SubscribeFunction = (
  schema: GraphQLSchema,
  document: DocumentNode,
  rootValue?: any,
  contextValue?: any,
  variableValues?: { [key: string]: any },
  operationName?: string,
  fieldResolver?: GraphQLFieldResolver<any, any>,
  subscribeFieldResolver?: GraphQLFieldResolver<any, any>
) =>
  | AsyncIterator<ExecutionResult>
  | Promise<AsyncIterator<ExecutionResult> | ExecutionResult>;

export type ParseType = (
  source: string | Source,
  options?: ParseOptions
) => DocumentNode | Promise<DocumentNode>;

export interface OnConnectResult {
  contextValue: Record<string, any> | boolean | undefined | null;
  parse: ParseType;
  validate: typeof defaultValidate;
  schema: GraphQLSchema;
}

export interface ServerOptions {
  rootValue?: any;
  execute: typeof defaultExecute;
  subscribe: SubscribeFunction;
  validationRules?:
    | Array<(context: ValidationContext) => any>
    | ReadonlyArray<any>;
  onOperation?: Function;
  onOperationComplete?: Function;
  onConnect: (
    connectionParams: OperationMessage['payload'] | undefined,
    connectionContext: ConnectionContext
  ) => Promise<OnConnectResult>;
  onDisconnect?: Function;
  keepAlive?: number;
}

const isWebSocketServer = (socket: any) => socket.on;

export class SubscriptionServer {
  private onOperation: Function;
  private onOperationComplete: Function;
  private onConnect: ServerOptions['onConnect'];
  private onDisconnect: Function;

  private wsServer: WebSocket.Server;
  private execute: typeof defaultExecute;
  private subscribe: SubscribeFunction;
  private rootValue: any;
  private keepAlive: number;
  private closeHandler: () => void;
  private specifiedRules:
    | Array<(context: ValidationContext) => any>
    | ReadonlyArray<any>;

  private parse: ParseType | null = null;
  private validate: typeof defaultValidate | null = null;

  public static create(
    options: ServerOptions,
    socketOptionsOrServer: WebSocket.ServerOptions | WebSocket.Server
  ) {
    return new SubscriptionServer(options, socketOptionsOrServer);
  }

  constructor(
    options: ServerOptions,
    socketOptionsOrServer: WebSocket.ServerOptions | WebSocket.Server
  ) {
    const {
      onOperation,
      onOperationComplete,
      onConnect,
      onDisconnect,
      keepAlive,
    } = options;

    this.specifiedRules = options.validationRules || specifiedRules;
    this.loadExecutor(options);

    this.onOperation = onOperation;
    this.onOperationComplete = onOperationComplete;
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
    this.keepAlive = keepAlive;

    if (isWebSocketServer(socketOptionsOrServer)) {
      this.wsServer = <WebSocket.Server>socketOptionsOrServer;
    } else {
      // Init and connect WebSocket server to http
      this.wsServer = new WebSocket.Server(socketOptionsOrServer || {});
    }

    const connectionHandler = (socket: WebSocket, request: IncomingMessage) => {
      // Add `upgradeReq` to the socket object to support old API, without creating a memory leak
      // See: https://github.com/websockets/ws/pull/1099
      (socket as any).upgradeReq = request;
      if (
        socket.protocol === undefined ||
        socket.protocol.indexOf(GRAPHQL_WS) === -1
      ) {
        // Close the connection with an error code, ws v2 ensures that the
        // connection is cleaned up even when the closing handshake fails.
        // 1002: protocol error
        socket.close(1002);

        return;
      }

      const connectionContext: ConnectionContext = Object.create(null);

      connectionContext.isLegacy = false;
      connectionContext.socket = socket;
      connectionContext.request = request;
      connectionContext.operations = {};

      const connectionClosedHandler = (error: any) => {
        if (error) {
          this.sendError(
            connectionContext,
            '',
            { message: error.message ? error.message : error },
            MessageTypes.GQL_CONNECTION_ERROR
          );

          setTimeout(() => {
            // 1011 is an unexpected condition prevented the request from being fulfilled
            connectionContext.socket.close(1011);
          }, 10);
        }
        this.onClose(connectionContext);

        if (this.onDisconnect) {
          this.onDisconnect(socket, connectionContext);
        }
      };

      socket.on('error', connectionClosedHandler);
      socket.on('close', connectionClosedHandler);
      socket.on('message', this.onMessage(connectionContext));
    };

    this.wsServer.on('connection', connectionHandler);
    this.closeHandler = () => {
      this.wsServer.removeListener('connection', connectionHandler);
      this.wsServer.close();
    };
  }

  public get server(): WebSocket.Server {
    return this.wsServer;
  }

  public close(): void {
    this.closeHandler();
  }

  private loadExecutor(options: ServerOptions) {
    const { execute, subscribe, rootValue } = options;

    if (!execute) {
      throw new Error(
        'Must provide `execute` for websocket server constructor.'
      );
    }

    this.rootValue = rootValue;
    this.execute = execute;
    this.subscribe = subscribe;
  }

  private unsubscribe(connectionContext: ConnectionContext, opId: string) {
    if (connectionContext.operations && connectionContext.operations[opId]) {
      if (connectionContext.operations[opId].return) {
        connectionContext.operations[opId].return();
      }

      delete connectionContext.operations[opId];

      if (this.onOperationComplete) {
        this.onOperationComplete(connectionContext.socket, opId);
      }
    }
  }

  private onClose(connectionContext: ConnectionContext) {
    Object.keys(connectionContext.operations).forEach((opId) => {
      this.unsubscribe(connectionContext, opId);
    });
  }

  private onMessage(connectionContext: ConnectionContext) {
    return (message: any) => {
      let parsedMessage: OperationMessage;
      try {
        parsedMessage = parseLegacyProtocolMessage(
          connectionContext,
          JSON.parse(message)
        );
      } catch (e) {
        this.sendError(
          connectionContext,
          null,
          { message: e.message },
          MessageTypes.GQL_CONNECTION_ERROR
        );
        return;
      }

      const opId = parsedMessage.id;
      switch (parsedMessage.type) {
        case MessageTypes.GQL_CONNECTION_INIT:
          if (this.onConnect) {
            connectionContext.initPromise = new Promise<OnConnectResult>(
              (resolve, reject) => {
                try {
                  this.onConnect(parsedMessage.payload, connectionContext).then(
                    resolve,
                    reject
                  );
                } catch (e) {
                  reject(e);
                }
              }
            );
          }

          connectionContext.initPromise
            .then(({ contextValue }) => {
              if (contextValue === false) {
                throw new Error('Prohibited connection!');
              }

              this.sendMessage(
                connectionContext,
                undefined,
                MessageTypes.GQL_CONNECTION_ACK,
                undefined
              );

              if (this.keepAlive) {
                this.sendKeepAlive(connectionContext);
                // Regular keep alive messages if keepAlive is set
                const keepAliveTimer = setInterval(() => {
                  if (connectionContext.socket.readyState === WebSocket.OPEN) {
                    this.sendKeepAlive(connectionContext);
                  } else {
                    clearInterval(keepAliveTimer);
                  }
                }, this.keepAlive);
              }
            })
            .catch((error: Error) => {
              this.sendError(
                connectionContext,
                opId,
                { message: error.message },
                MessageTypes.GQL_CONNECTION_ERROR
              );

              // Close the connection with an error code, ws v2 ensures that the
              // connection is cleaned up even when the closing handshake fails.
              // 1011: an unexpected condition prevented the operation from being fulfilled
              // We are using setTimeout because we want the message to be flushed before
              // disconnecting the client
              setTimeout(() => {
                connectionContext.socket.close(1011);
              }, 10);
            });
          break;

        case MessageTypes.GQL_CONNECTION_TERMINATE:
          connectionContext.socket.close();
          break;

        case MessageTypes.GQL_START:
          connectionContext.initPromise
            .then((initResult) => {
              // if we already have a subscription with this id, unsubscribe from it first
              if (
                connectionContext.operations &&
                connectionContext.operations[opId]
              ) {
                this.unsubscribe(connectionContext, opId);
              }

              const baseParams: ExecutionParams = {
                query: parsedMessage.payload.query,
                variables: parsedMessage.payload.variables,
                operationName: parsedMessage.payload.operationName,
                context: isObject(initResult.contextValue)
                  ? Object.assign(
                      Object.create(
                        Object.getPrototypeOf(initResult.contextValue)
                      ),
                      initResult.contextValue
                    )
                  : {},
                formatResponse: <any>undefined,
                formatError: <any>undefined,
                callback: <any>undefined,
                schema: initResult.schema,
                parse: initResult.parse,
                validate: initResult.validate,
              };
              let promisedParams = Promise.resolve(baseParams);

              // set an initial mock subscription to only registering opId
              connectionContext.operations[opId] = createEmptyIterable();

              if (this.onOperation) {
                let messageForCallback: any = parsedMessage;
                promisedParams = Promise.resolve(
                  this.onOperation(
                    messageForCallback,
                    baseParams,
                    connectionContext.socket
                  )
                );
              }

              return promisedParams
                .then(async (params) => {
                  if (typeof params !== 'object') {
                    const error = `Invalid params returned from onOperation! return values must be an object!`;
                    this.sendError(connectionContext, opId, { message: error });

                    throw new Error(error);
                  }

                  if (!params.schema) {
                    const error =
                      'Missing schema information. The GraphQL schema should be provided either statically in' +
                      ' the `SubscriptionServer` constructor or as a property on the object returned from onOperation!';
                    this.sendError(connectionContext, opId, { message: error });

                    throw new Error(error);
                  }

                  if (!this.parse || !this.validate)
                    throw Error(`Connection not initialized correctly!`);

                  const document =
                    typeof baseParams.query !== 'string'
                      ? baseParams.query
                      : await this.parse(baseParams.query);
                  let executionPromise: Promise<
                    AsyncIterator<ExecutionResult> | ExecutionResult
                  >;
                  const validationErrors = this.validate(
                    params.schema,
                    document,
                    this.specifiedRules
                  );

                  if (validationErrors.length > 0) {
                    executionPromise = Promise.resolve({
                      errors: validationErrors,
                    });
                  } else {
                    let executor: SubscribeFunction | typeof defaultExecute =
                      this.execute;
                    if (
                      this.subscribe &&
                      isASubscriptionOperation(document, params.operationName)
                    ) {
                      executor = this.subscribe;
                    }
                    executionPromise = Promise.resolve(
                      executor(
                        params.schema,
                        document,
                        this.rootValue,
                        params.context,
                        params.variables,
                        params.operationName
                      )
                    );
                  }

                  return executionPromise.then((executionResult) => ({
                    executionIterable: isAsyncIterable(executionResult)
                      ? executionResult
                      : createAsyncIterator([executionResult]),
                    params,
                  }));
                })
                .then(({ executionIterable, params }) => {
                  forAwaitEach(
                    executionIterable as any,
                    (value: ExecutionResult) => {
                      let result = value;

                      if (params.formatResponse) {
                        try {
                          result = params.formatResponse(value, params);
                        } catch (err) {
                          console.error(
                            'Error in formatResponse function:',
                            err
                          );
                        }
                      }

                      this.sendMessage(
                        connectionContext,
                        opId,
                        MessageTypes.GQL_DATA,
                        result
                      );
                    }
                  )
                    .then(() => {
                      this.sendMessage(
                        connectionContext,
                        opId,
                        MessageTypes.GQL_COMPLETE,
                        null
                      );
                    })
                    .catch((e: Error) => {
                      let error = e;

                      if (params.formatError) {
                        try {
                          error = params.formatError(e, params);
                        } catch (err) {
                          console.error('Error in formatError function: ', err);
                        }
                      }

                      // plain Error object cannot be JSON stringified.
                      if (Object.keys(error).length === 0) {
                        error = { name: error.name, message: error.message };
                      }

                      this.sendError(connectionContext, opId, error);
                    });

                  return executionIterable;
                })
                .then((subscription: ExecutionIterator) => {
                  connectionContext.operations[opId] = subscription;
                })
                .then(() => {
                  // NOTE: This is a temporary code to support the legacy protocol.
                  // As soon as the old protocol has been removed, this coode should also be removed.
                  this.sendMessage(
                    connectionContext,
                    opId,
                    MessageTypes.SUBSCRIPTION_SUCCESS,
                    undefined
                  );
                })
                .catch((e: any) => {
                  if (e.errors) {
                    this.sendMessage(
                      connectionContext,
                      opId,
                      MessageTypes.GQL_DATA,
                      {
                        errors: e.errors,
                      }
                    );
                  } else {
                    this.sendError(connectionContext, opId, {
                      message: e.message,
                    });
                  }

                  // Remove the operation on the server side as it will be removed also in the client
                  this.unsubscribe(connectionContext, opId);
                  return;
                });
            })
            .catch((error) => {
              // Handle initPromise rejected
              this.sendError(connectionContext, opId, {
                message: error.message,
              });
              this.unsubscribe(connectionContext, opId);
            });
          break;

        case MessageTypes.GQL_STOP:
          // Find subscription id. Call unsubscribe.
          this.unsubscribe(connectionContext, opId);
          break;

        default:
          this.sendError(connectionContext, opId, {
            message: 'Invalid message type!',
          });
      }
    };
  }

  private sendKeepAlive(connectionContext: ConnectionContext): void {
    if (connectionContext.isLegacy) {
      this.sendMessage(
        connectionContext,
        undefined,
        MessageTypes.KEEP_ALIVE,
        undefined
      );
    } else {
      this.sendMessage(
        connectionContext,
        undefined,
        MessageTypes.GQL_CONNECTION_KEEP_ALIVE,
        undefined
      );
    }
  }

  private sendMessage(
    connectionContext: ConnectionContext,
    opId: string,
    type: string,
    payload: any
  ): void {
    const parsedMessage = parseLegacyProtocolMessage(connectionContext, {
      type,
      id: opId,
      payload,
    });

    if (
      parsedMessage &&
      connectionContext.socket.readyState === WebSocket.OPEN
    ) {
      connectionContext.socket.send(JSON.stringify(parsedMessage));
    }
  }

  private sendError(
    connectionContext: ConnectionContext,
    opId: string,
    errorPayload: any,
    overrideDefaultErrorType?: string
  ): void {
    const sanitizedOverrideDefaultErrorType =
      overrideDefaultErrorType || MessageTypes.GQL_ERROR;
    if (
      [MessageTypes.GQL_CONNECTION_ERROR, MessageTypes.GQL_ERROR].indexOf(
        sanitizedOverrideDefaultErrorType
      ) === -1
    ) {
      throw new Error(
        'overrideDefaultErrorType should be one of the allowed error messages' +
          ' GQL_CONNECTION_ERROR or GQL_ERROR'
      );
    }

    this.sendMessage(
      connectionContext,
      opId,
      sanitizedOverrideDefaultErrorType,
      errorPayload
    );
  }
}
