// Copyright © 2022 Kaleido, Inc.
//
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AxiosRequestConfig } from 'axios';
import { lastValueFrom } from 'rxjs';
import {
  Event,
  EventStream,
  EventStreamReply,
  TokenCreateEvent,
  TransferEvent,
} from '../event-stream/event-stream.interfaces';
import { EventStreamService } from '../event-stream/event-stream.service';
import { EventStreamProxyGateway } from '../eventstream-proxy/eventstream-proxy.gateway';
import { EventListener, EventProcessor } from '../eventstream-proxy/eventstream-proxy.interfaces';
import { basicAuth } from '../utils';
import { WebSocketMessage } from '../websocket-events/websocket-events.base';
import {
  AsyncResponse,
  EthConnectAsyncResponse,
  EthConnectReturn,
  TokenBalance,
  TokenBalanceQuery,
  TokenBurn,
  TokenBurnEvent,
  TokenMint,
  TokenMintEvent,
  TokenPool,
  TokenPoolActivate,
  TokenPoolEvent,
  TokenTransfer,
  TokenTransferEvent,
  TokenType,
  TransactionDetails,
} from './tokens.interfaces';
import { decodeHex, encodeHex, packSubscriptionName, unpackSubscriptionName } from './tokens.util';

const TOKEN_STANDARD = 'ERC20';
const BASE_SUBSCRIPTION_NAME = 'base';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const tokenCreateEvent = 'TokenCreate';
const tokenCreateEventSignature = 'TokenCreate(address,address,string,string,bytes)';
const transferEvent = 'Transfer';
const transferEventSignature = 'Transfer(address,address,uint256)';

@Injectable()
export class TokensService {
  baseUrl: string;
  instancePath: string;
  instanceUrl: string;
  topic: string;
  shortPrefix: string;
  contractABI: string;
  contractInstanceUrl: string;
  stream: EventStream;
  username: string;
  password: string;

  constructor(
    private http: HttpService,
    private eventstream: EventStreamService,
    private proxy: EventStreamProxyGateway,
  ) {}

  configure(
    baseUrl: string,
    instancePath: string,
    topic: string,
    shortPrefix: string,
    contractABI: string,
    username: string,
    password: string,
  ) {
    this.baseUrl = baseUrl;
    this.instancePath = instancePath;
    this.instanceUrl = `${baseUrl}${instancePath}`;
    this.topic = topic;
    this.shortPrefix = shortPrefix;
    this.contractABI = contractABI;
    this.contractInstanceUrl = `${this.baseUrl}/abis/${contractABI}`;
    this.username = username;
    this.password = password;
    this.proxy.addListener(new TokenListener(this, this.topic));
  }

  /**
   * One-time initialization of event stream and base subscription.
   */
  async init() {
    this.stream = await this.eventstream.createOrUpdateStream(this.topic);
    await this.eventstream.getOrCreateSubscription(
      this.instanceUrl,
      this.stream.id,
      tokenCreateEvent,
      packSubscriptionName(this.topic, BASE_SUBSCRIPTION_NAME),
    );
  }

  private postOptions(operator: string, requestId?: string) {
    const from = `${this.shortPrefix}-from`;
    const sync = `${this.shortPrefix}-sync`;
    const id = `${this.shortPrefix}-id`;

    const requestOptions: AxiosRequestConfig = {
      params: {
        [from]: operator,
        [sync]: 'false',
        [id]: requestId,
      },
      ...basicAuth(this.username, this.password),
    };

    return requestOptions;
  }

  async createPool(dto: TokenPool): Promise<AsyncResponse> {
    const response = await lastValueFrom(
      this.http.post<EthConnectAsyncResponse>(
        `${this.instanceUrl}/create`,
        {
          data: encodeHex(dto.data ?? ''),
          name: dto.name,
          symbol: dto.symbol,
        },
        this.postOptions(dto.operator, dto.requestId),
      ),
    );

    return { id: response.data.id };
  }

  async activatePool(dto: TokenPoolActivate) {
    await Promise.all([
      this.eventstream.getOrCreateSubscription(
        `${this.baseUrl}/${this.instancePath}`,
        this.stream.id,
        tokenCreateEvent,
        packSubscriptionName(this.topic, dto.poolId, tokenCreateEvent),
        dto.transaction?.blockNumber ?? '0',
      ),
      this.eventstream.getOrCreateSubscription(
        `${this.contractInstanceUrl}/${dto.poolId}`,
        this.stream.id,
        transferEvent,
        packSubscriptionName(this.topic, dto.poolId, transferEvent),
        dto.transaction?.blockNumber ?? '0',
      ),
    ]);
  }

  async mint(dto: TokenMint): Promise<AsyncResponse> {
    const response = await lastValueFrom(
      this.http.post<EthConnectAsyncResponse>(
        `${this.contractInstanceUrl}/${dto.poolId}/mintWithData`,
        {
          amount: dto.amount,
          data: encodeHex(dto.data ?? ''),
          to: dto.to,
        },
        this.postOptions(dto.operator, dto.requestId),
      ),
    );
    return { id: response.data.id };
  }

  async transfer(dto: TokenTransfer): Promise<AsyncResponse> {
    const response = await lastValueFrom(
      this.http.post<EthConnectAsyncResponse>(
        `${this.contractInstanceUrl}/${dto.poolId}/transferWithData`,
        {
          from: dto.from,
          to: dto.to,
          amount: dto.amount,
          data: encodeHex(dto.data ?? ''),
        },
        this.postOptions(dto.operator, dto.requestId),
      ),
    );
    return { id: response.data.id };
  }

  async burn(dto: TokenBurn): Promise<AsyncResponse> {
    const response = await lastValueFrom(
      this.http.post<EthConnectAsyncResponse>(
        `${this.contractInstanceUrl}/${dto.poolId}/burnWithData`,
        {
          data: encodeHex(dto.data ?? ''),
          from: dto.from,
          amount: dto.amount,
        },
        this.postOptions(dto.operator, dto.requestId),
      ),
    );
    return { id: response.data.id };
  }

  async balance(dto: TokenBalanceQuery): Promise<TokenBalance> {
    const response = await lastValueFrom(
      this.http.get<EthConnectReturn>(`${this.contractInstanceUrl}/${dto.poolId}/balanceOf`, {
        params: {
          account: dto.account,
        },
        ...basicAuth(this.username, this.password),
      }),
    );

    return { balance: response.data.output };
  }

  async getReceipt(id: string): Promise<EventStreamReply> {
    const response = await lastValueFrom(
      this.http.get<EventStreamReply>(`${this.baseUrl}/reply/${id}`, {
        validateStatus: status => status < 300 || status === 404,
        ...basicAuth(this.username, this.password),
      }),
    );
    if (response.status === 404) {
      throw new NotFoundException();
    }
    return response.data;
  }

  public async getOperator(poolId: string, txId: string, inputMethod: string): Promise<string> {
    const response = await lastValueFrom(
      this.http.get<TransactionDetails>(
        `${this.contractInstanceUrl}/${poolId}/${inputMethod}?fly-transaction=${txId}&stream=${this.stream.id}`,
        {
          ...basicAuth(this.username, this.password),
        },
      ),
    );
    return response.data.from;
  }
}

class TokenListener implements EventListener {
  private readonly logger = new Logger(TokenListener.name);

  constructor(private readonly service: TokensService, private topic: string) {}

  async onEvent(subName: string, event: Event, process: EventProcessor) {
    switch (event.signature) {
      case tokenCreateEventSignature:
        process(this.transformTokenCreateEvent(subName, event));
        break;
      case transferEventSignature: {
        const transformedEvent = await this.transformTransferEvent(subName, event);
        process(transformedEvent);
        break;
      }
      default:
        this.logger.error(`Unknown event signature: ${event.signature}`);
        return undefined;
    }
  }

  private transformTokenCreateEvent(
    subName: string,
    event: TokenCreateEvent,
  ): WebSocketMessage | undefined {
    const { data } = event;
    const unpackedSub = unpackSubscriptionName(this.topic, subName);
    const decodedData = decodeHex(data.data ?? '');

    if (
      unpackedSub.poolId !== BASE_SUBSCRIPTION_NAME &&
      unpackedSub.poolId !== data.contract_address
    ) {
      return undefined;
    }

    return {
      event: 'token-pool',
      data: <TokenPoolEvent>{
        standard: TOKEN_STANDARD,
        poolId: event.data.contract_address,
        type: TokenType.FUNGIBLE,
        operator: data.operator,
        data: decodedData,
        timestamp: event.timestamp,
        rawOutput: data,
        transaction: {
          blockNumber: event.blockNumber,
          transactionIndex: event.transactionIndex,
          transactionHash: event.transactionHash,
          logIndex: event.logIndex,
          signature: event.signature,
        },
      },
    };
  }

  private async transformTransferEvent(
    subName: string,
    event: TransferEvent,
  ): Promise<WebSocketMessage | undefined> {
    const { data } = event;
    const unpackedSub = unpackSubscriptionName(this.topic, subName);
    const decodedData = decodeHex(event.inputArgs?.data ?? '');

    if (data.from === ZERO_ADDRESS && data.to === ZERO_ADDRESS) {
      // should not happen
      return undefined;
    }

    const txIndex = BigInt(event.transactionIndex).toString(10);
    const transferId = [event.blockNumber, txIndex, event.logIndex].join('.');
    // TODO: Have ethconnect fetch this
    const operator: string = await this.service.getOperator(
      event.address,
      event.transactionHash,
      event.inputMethod ?? '',
    );

    const commonData = <TokenTransferEvent>{
      id: transferId,
      type: TokenType.FUNGIBLE,
      poolId: unpackedSub.poolId,
      amount: data.value,
      operator,
      data: decodedData,
      timestamp: event.timestamp,
      rawOutput: data,
      transaction: {
        blockNumber: event.blockNumber,
        transactionIndex: event.transactionIndex,
        transactionHash: event.transactionHash,
        logIndex: event.logIndex,
        signature: event.signature,
      },
    };

    if (data.from === ZERO_ADDRESS) {
      return {
        event: 'token-mint',
        data: { ...commonData, to: data.to } as TokenMintEvent,
      };
    } else if (data.to === ZERO_ADDRESS) {
      return {
        event: 'token-burn',
        data: { ...commonData, from: data.from } as TokenBurnEvent,
      };
    } else {
      return {
        event: 'token-transfer',
        data: { ...commonData, from: data.from, to: data.to } as TokenTransferEvent,
      };
    }
  }
}
