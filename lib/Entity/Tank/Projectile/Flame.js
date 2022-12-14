"use strict";
/*
    DiepCustom - custom tank game server that shares diep.io's WebSocket protocol
    Copyright (C) 2022 ABCxFF (github.com/ABCxFF)

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published
    by the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.

    You should have received a copy of the GNU Affero General Public License
    along with this program. If not, see <https://www.gnu.org/licenses/>
*/
Object.defineProperty(exports, "__esModule", { value: true });
const Bullet_1 = require("./Bullet");
class Flame extends Bullet_1.default {
    constructor(barrel, tank, tankDefinition, shootAngle) {
        super(barrel, tank, tankDefinition, shootAngle);
        this.baseSpeed *= 2;
        this.baseAccel = 0;
        this.damageReduction = 1;
        this.physics.values.sides = 4;
        this.physics.values.absorbtionFactor = this.physics.values.pushFactor = 0;
        this.lifeLength = 25 * barrel.definition.bullet.lifeLength;
    }
    destroy(animate) {
        super.destroy(false);
    }
    tick(tick) {
        super.tick(tick);
        this.damageReduction += 1 / 25;
        this.style.opacity -= 1 / 25;
    }
}
exports.default = Flame;
