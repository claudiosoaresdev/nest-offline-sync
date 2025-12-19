import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { NotificationsService } from './notifications.service';

@WebSocketGateway({
  namespace: '/notifications',
  cors: { origin: '*' },
})
export class NotificationsGateway
  implements OnGatewayInit, OnGatewayConnection
{
  @WebSocketServer()
  server!: Server;

  constructor(private readonly notifications: NotificationsService) {}

  afterInit() {
    this.notifications.setServer(this.server);
  }

  handleConnection(client: Socket) {
    // replay dos últimos itens assim que o client conecta
    const latest = this.notifications.listLatest(25);
    client.emit('notifications:replay', latest);
  }
}
