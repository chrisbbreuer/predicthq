import { response } from '@stacksjs/router'
import { scan } from '../../Services/scanner'

/**
 * GET /api/scanner — live and upcoming game markets with their movement
 * and the model's view. Public data only, cached for twenty seconds, so
 * any number of open scanners cost the venue one pass per window.
 */
export default {
  name: 'GetScanner',
  description: 'Live and upcoming game markets with price movement and model view.',

  async handle() {
    try {
      return await scan()
    }
    catch {
      return response.error('The scanner could not reach Kalshi. Try again in a moment.', 502)
    }
  },
}
