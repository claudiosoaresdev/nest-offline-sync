import { Module } from '@nestjs/common';
import { OrderEventsController } from 'src/modules/events/order-events.controller';
import { OrderEventsService } from 'src/modules/events/order-events.service';

@Module({
  controllers: [OrderEventsController],
  providers: [OrderEventsService],
  exports: [OrderEventsService],
})
export class EventsModule {}
