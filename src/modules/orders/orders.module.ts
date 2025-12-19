import { Module } from '@nestjs/common';
import { EventsModule } from 'src/modules/events/events.module';
import { IdempotencyModule } from 'src/modules/idempotency/idempotency.module';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';
import { OrdersController } from 'src/modules/orders/orders.controller';
import { OrdersService } from 'src/modules/orders/orders.service';

@Module({
  imports: [IdempotencyModule, EventsModule, NotificationsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
