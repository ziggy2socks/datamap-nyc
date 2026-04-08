import { RestaurantProvider } from './RestaurantContext';
import RestaurantShell from './RestaurantShell';

export default function RestaurantsApp() {
  return (
    <RestaurantProvider>
      <RestaurantShell />
    </RestaurantProvider>
  );
}
