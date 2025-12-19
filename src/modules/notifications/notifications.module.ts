import { Module } from '@nestjs/common';
import { NotificationsGateway } from 'src/modules/notifications/notifications.gateway';
import { NotificationsService } from 'src/modules/notifications/notifications.service';

@Module({
  providers: [NotificationsGateway, NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
