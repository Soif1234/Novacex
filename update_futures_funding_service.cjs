const fs = require('fs');
let content = fs.readFileSync('src/services/futures/FuturesFundingService.ts', 'utf8');

content = content.replace(`      if (fundingPayment.gt(0)) {
          // Pay funding
          const absAmount = fundingPayment;
          let debitAmount = absAmount;
          const avail = new Decimal(this.ledger.getBalance('USDT'));
          if (avail.lt(absAmount)) {
              debitAmount = avail;
              // If we wanted to trigger liquidation here, we could. For now just take max avail.
          }
          if (debitAmount.gt(0)) {
              this.ledger.debit('USDT', debitAmount.toString(), \`FUNDING_PAYMENT for \${pos.symbol} \${pos.side}\`);
          }
      } else {
          this.ledger.credit('USDT', absAmount.toString(), \`FUNDING_RECEIPT for \${pos.symbol} \${pos.side}\`);
      }`, `      if (fundingPayment.gt(0)) {
          // Pay funding
          const absAmount = fundingPayment;
          let debitAmount = absAmount;
          const avail = new Decimal(this.ledger.getBalance('USDT'));
          if (avail.lt(absAmount)) {
              debitAmount = avail;
              // If we wanted to trigger liquidation here, we could. For now just take max avail.
          }
          if (debitAmount.gt(0)) {
              this.ledger.debit('USDT', debitAmount.toString(), \`FUNDING_PAYMENT for \${pos.symbol} \${pos.side}\`);
          }
          
          const currentCumFunding = pos.cumulativeFunding ? new Decimal(pos.cumulativeFunding) : new Decimal(0);
          pos.cumulativeFunding = currentCumFunding.minus(debitAmount).toString();
      } else {
          this.ledger.credit('USDT', absAmount.toString(), \`FUNDING_RECEIPT for \${pos.symbol} \${pos.side}\`);
          const currentCumFunding = pos.cumulativeFunding ? new Decimal(pos.cumulativeFunding) : new Decimal(0);
          pos.cumulativeFunding = currentCumFunding.plus(absAmount).toString();
      }`);
fs.writeFileSync('src/services/futures/FuturesFundingService.ts', content);
