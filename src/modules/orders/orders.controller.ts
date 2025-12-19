import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ZodValidationPipe } from 'src/common/pipes/zod-validation.pipe';
import { IdempotencyInterceptor } from 'src/modules/idempotency/idempotency.interceptor';
import { Idempotent } from 'src/modules/idempotency/idempotent.decorator';
import {
  ConfirmOrderDto,
  ConfirmOrderSchema,
} from 'src/modules/orders/dto/confirm-order.schema';
import { CreateOrderResponseDto } from 'src/modules/orders/dto/create-order.response.schema';
import {
  CreateOrderDto,
  CreateOrderSchema,
} from 'src/modules/orders/dto/create-order.schema';
import { OrderDto } from 'src/modules/orders/dto/order.schema';
import {
  OrdersListQuerySchema,
  OrdersListResponseDto,
} from 'src/modules/orders/dto/orders-list.schema';
import { OrdersService } from 'src/modules/orders/orders.service';
import { z } from 'zod';

// pipes
const uuidParamPipe = new ZodValidationPipe(z.string().uuid());
const listQueryPipe = new ZodValidationPipe(OrdersListQuerySchema);
const createOrderBodyPipe = new ZodValidationPipe(CreateOrderSchema);
const confirmOrderBodyPipe = new ZodValidationPipe(ConfirmOrderSchema);

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /**
   * POST /orders
   *
   * Cria um pedido com itens montados offline e valida no servidor:
   * - checa existência / deletedAt
   * - checa estoque (se existir)
   * - recalcula preço (server truth)
   * - salva serverPriceCents por item
   * - calcula totalCents
   *
   * Retorna:
   * - status (CONFIRMED, REQUIRES_CONFIRMATION, REJECTED...)
   * - diffs (ex.: PRICE_CHANGED)
   * - totalCents final
   */
  @Post()
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  @ApiBody({ type: CreateOrderDto })
  @ZodResponse({ type: CreateOrderResponseDto })
  create(
    @Body(createOrderBodyPipe) body: CreateOrderDto,
  ): Promise<CreateOrderResponseDto> {
    return this.ordersService.createOrder(body);
  }

  /**
   * POST /orders/:id/confirm
   *
   * Confirma um pedido após o usuário aceitar os diffs (principalmente mudança de preço).
   * Importante: o servidor revalida preço/estoque novamente antes de confirmar.
   */
  @Post(':id/confirm')
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  @ApiBody({ type: ConfirmOrderDto })
  @ZodResponse({ type: CreateOrderResponseDto })
  confirm(
    @Param('id', uuidParamPipe) id: string,
    @Body(confirmOrderBodyPipe) body: ConfirmOrderDto,
  ): Promise<CreateOrderResponseDto> {
    return this.ordersService.confirmOrder(id, body);
  }

  /**
   * GET /orders/:id
   *
   * Retorna o estado atual do pedido:
   * - status
   * - itens (incluindo serverPriceCents e snapshots)
   * - eventos (para debug/polling; base do SSE depois)
   */
  @Get(':id')
  @ZodResponse({ type: OrderDto })
  get(@Param('id', uuidParamPipe) id: string): Promise<OrderDto> {
    return this.ordersService.getOrder(id);
  }

  @Get()
  @ZodResponse({ type: OrdersListResponseDto })
  list(@Query(listQueryPipe) q: z.infer<typeof OrdersListQuerySchema>) {
    return this.ordersService.listOrders(q);
  }

  @Post(':id/cancel')
  cancel(@Param('id', uuidParamPipe) id: string) {
    return this.ordersService.cancelOrder(id);
  }
}
