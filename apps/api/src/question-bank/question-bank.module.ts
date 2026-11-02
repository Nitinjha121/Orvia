import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { QuestionBankController } from './question-bank.controller';
import { QuestionBankService } from './question-bank.service';
import { PracticeRotationService } from './practice-rotation.service';

@Module({
  imports: [AuthModule],
  controllers: [QuestionBankController],
  providers: [QuestionBankService, PracticeRotationService],
  // The rotation is exported as well as the banks: the mentor answers "what
  // have I not done yet", which is the same arithmetic the practice rail runs.
  exports: [QuestionBankService, PracticeRotationService],
})
export class QuestionBankModule {}
