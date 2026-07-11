import { Hono } from 'hono';
import type { Bindings } from './helpers';
import { register as registerNStar } from './n-star';
import { register as registerKaraoke } from './karaoke';
import { register as registerBookings } from './bookings';
import { register as registerArt } from './art';
import { register as registerGeneral } from './general';
import { register as registerOutreach } from './outreach';
import { register as registerPayment } from './payment';
import { register as registerOffice } from './office';

const app = new Hono<{ Bindings: Bindings }>();

registerNStar(app);
registerKaraoke(app);
registerBookings(app);
registerArt(app);
registerGeneral(app);
registerOutreach(app);
registerPayment(app);
registerOffice(app);

export default app;
